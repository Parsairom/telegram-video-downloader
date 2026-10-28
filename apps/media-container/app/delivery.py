"""Delivery of the finished file: Telegram (cloud or local Bot API) or an expiring R2 download link."""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import mimetypes
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx

from .config import Settings
from .errors import MediaError

log = logging.getLogger("tvd.delivery")

R2_PART_SIZE = 32 * 1024 * 1024  # R2 needs equal-sized parts (except the last); 32 MiB keeps Worker bodies small

ProgressFn = Callable[[int, int], None]


class _CountingFile:
    """File object that reports bytes read — lets httpx stream a multi-GB multipart upload with progress."""

    def __init__(self, path: Path, on_progress: ProgressFn | None):
        self._fh = path.open("rb")
        self._total = path.stat().st_size
        self._sent = 0
        self._on_progress = on_progress

    def fileno(self) -> int:
        return self._fh.fileno()

    def seek(self, offset: int, whence: int = 0) -> int:
        pos = self._fh.seek(offset, whence)
        if offset == 0 and whence == 0:
            self._sent = 0
        return pos

    def tell(self) -> int:
        return self._fh.tell()

    def read(self, size: int = -1) -> bytes:
        chunk = self._fh.read(size)
        self._sent += len(chunk)
        if self._on_progress and chunk:
            self._on_progress(self._sent, self._total)
        return chunk

    def close(self) -> None:
        self._fh.close()


def _classify_telegram_error(status: int, description: str) -> tuple[str, bool]:
    low = description.lower()
    if status == 413 or "file is too big" in low or "request entity too large" in low:
        return "too_large", False
    if status == 429:
        return "rate_limited", True
    if any(k in low for k in ("chat not found", "bot was blocked", "user is deactivated", "bot can't initiate", "forbidden")):
        return "telegram_error", False
    if status in (400,) and any(k in low for k in ("wrong file", "failed to get http url content", "wrong type of the web page content")):
        return "upload_failed", False
    if status >= 500:
        return "upload_failed", True
    if status == 401:
        return "telegram_error", False
    return "telegram_error", status in (408, 409, 420)


class TelegramSender:
    def __init__(self, settings: Settings, *, local: bool):
        self.settings = settings
        self.local = local
        self.base = settings.local_bot_api_url if local else settings.telegram_api_base
        self.limit = settings.local_upload_limit_bytes if local else settings.cloud_upload_limit_bytes

    @property
    def token(self) -> str | None:
        return (self.settings.local_bot_token or self.settings.bot_token) if self.local else self.settings.bot_token

    def _url(self, method: str) -> str:
        assert self.token
        return f"{self.base}/bot{self.token}/{method}"

    async def send(
        self,
        *,
        chat_id: int,
        path: Path,
        kind: str,
        send_as: str,
        container: str,
        caption: str,
        filename: str,
        thumb: Path | None,
        reply_to: int | None,
        duration: float | None,
        width: int | None,
        height: int | None,
        title: str | None,
        performer: str | None,
        upload_timeout: float,
        on_progress: ProgressFn | None,
    ) -> dict[str, Any]:
        if not self.token:
            raise MediaError("telegram_error", "BOT_TOKEN is not configured in the container", retryable=False)
        size = path.stat().st_size
        if size > self.limit:
            raise MediaError(
                "too_large",
                f"file is {size} bytes, above this delivery mode's verified limit of {self.limit} bytes",
                retryable=False,
            )

        # sendVideo only plays inline for MP4; anything else goes as a document unless audio.
        if kind == "audio":
            method, field = "sendAudio", "audio"
        elif send_as == "document" or (send_as == "auto" and container not in ("mp4", "original")) or (
            send_as == "auto" and path.suffix.lower() not in (".mp4", ".m4v", ".mov")
        ):
            method, field = "sendDocument", "document"
        else:
            method, field = "sendVideo", "video"

        data: dict[str, str] = {"chat_id": str(chat_id), "caption": caption, "parse_mode": "HTML"}
        if reply_to:
            data["reply_parameters"] = json.dumps({"message_id": reply_to, "allow_sending_without_reply": True})
        if method == "sendVideo":
            data["supports_streaming"] = "true"
            if duration:
                data["duration"] = str(int(round(duration)))
            if width and height:
                data["width"], data["height"] = str(width), str(height)
        elif method == "sendAudio":
            if duration:
                data["duration"] = str(int(round(duration)))
            if title:
                data["title"] = title[:100]
            if performer:
                data["performer"] = performer[:100]
        elif method == "sendDocument":
            data["disable_content_type_detection"] = "true"

        for attempt in range(1, 4):
            files: dict[str, Any] = {}
            counting: _CountingFile | None = None
            try:
                if self.local:
                    # the Bot API server runs in this container and reads the file straight from disk
                    data[field] = f"file://{path.resolve()}"
                    if thumb:
                        data["thumbnail"] = f"file://{thumb.resolve()}"
                else:
                    counting = _CountingFile(path, on_progress)
                    files[field] = (filename, counting, mimetypes.guess_type(filename)[0] or "application/octet-stream")
                    if thumb:
                        files["thumbnail"] = ("thumb.jpg", thumb.read_bytes(), "image/jpeg")
                timeout = httpx.Timeout(connect=30.0, read=upload_timeout, write=upload_timeout, pool=30.0)
                # the loopback local Bot API server must not go through the proxy; api.telegram.org may need it
                proxy = None if self.local else self.settings.telegram_proxy
                async with httpx.AsyncClient(timeout=timeout, proxy=proxy) as client:
                    resp = await client.post(self._url(method), data=data, files=files or None)
                try:
                    body = resp.json()
                except ValueError:
                    body = {"ok": False, "description": resp.text[:200]}
                if body.get("ok"):
                    return _delivery_fields(body["result"], method, size, filename, duration, width, height)
                description = str(body.get("description", f"HTTP {resp.status_code}"))
                code, retryable = _classify_telegram_error(resp.status_code, description)
                if code == "rate_limited":
                    wait = float((body.get("parameters") or {}).get("retry_after", 5))
                    log.info("telegram flood wait %ss", wait)
                    if attempt < 3 and wait <= 120:
                        await asyncio.sleep(wait + 1)
                        continue
                if retryable and attempt < 3:
                    await asyncio.sleep(2**attempt)
                    continue
                raise MediaError(code, description, retryable=retryable)
            except httpx.HTTPError as exc:
                if attempt >= 3:
                    raise MediaError("upload_failed", f"upload failed: {type(exc).__name__}: {exc}", retryable=True) from exc
                log.info("upload attempt %s failed: %s", attempt, type(exc).__name__)
                await asyncio.sleep(2**attempt)
            finally:
                if counting:
                    counting.close()
        raise MediaError("upload_failed", "upload failed after retries", retryable=True)


def _delivery_fields(
    result: dict[str, Any], method: str, size: int, filename: str, duration: float | None, width: int | None, height: int | None
) -> dict[str, Any]:
    media = result.get("video") or result.get("audio") or result.get("document") or {}
    return {
        "telegramMessageId": result.get("message_id"),
        "telegramFileId": media.get("file_id"),
        "sizeBytes": size,
        "filename": filename,
        "durationSeconds": duration,
        "width": width,
        "height": height,
        "downloadUrl": None,
        "downloadUrlExpiresAt": None,
        "sha256": None,
        "method": method,
    }


class R2LinkUploader:
    """Streams the file to R2 through the Worker's internal multipart endpoints (the container holds no R2 keys)."""

    def __init__(self, base_url: str, job_id: str, token: str, correlation_id: str):
        self.base = f"{base_url.rstrip('/')}/internal/jobs/{job_id}/r2"
        self.headers = {"Authorization": f"Bearer {token}", "X-Correlation-Id": correlation_id}

    async def upload(self, path: Path, filename: str, on_progress: ProgressFn | None) -> dict[str, Any]:
        size = path.stat().st_size
        timeout = httpx.Timeout(connect=30.0, read=300.0, write=300.0, pool=30.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                f"{self.base}/create",
                headers=self.headers,
                json={"filename": filename, "size": size, "contentType": mimetypes.guess_type(filename)[0] or "application/octet-stream"},
            )
            if resp.status_code >= 300:
                raise MediaError("upload_failed", f"could not start the R2 upload (HTTP {resp.status_code})", retryable=True)
            started = resp.json()
            upload_id = started["uploadId"]
            part_size = int(started.get("partSize", R2_PART_SIZE))
            digest = hashlib.sha256()
            parts: list[dict[str, Any]] = []
            sent = 0
            try:
                with path.open("rb") as fh:
                    number = 0
                    while True:
                        chunk = await asyncio.to_thread(fh.read, part_size)
                        if not chunk:
                            break
                        number += 1
                        digest.update(chunk)
                        etag = await self._put_part(client, upload_id, number, chunk)
                        parts.append({"partNumber": number, "etag": etag})
                        sent += len(chunk)
                        if on_progress:
                            on_progress(sent, size)
                done = await client.post(
                    f"{self.base}/complete",
                    headers=self.headers,
                    json={"uploadId": upload_id, "parts": parts, "sha256": digest.hexdigest(), "size": size},
                )
                if done.status_code >= 300:
                    raise MediaError("upload_failed", f"could not finish the R2 upload (HTTP {done.status_code}): {done.text[:200]}", retryable=True)
                result = done.json()
            except BaseException:
                await asyncio.shield(self._abort(client, upload_id))
                raise
        return {
            "telegramMessageId": None,
            "telegramFileId": None,
            "sizeBytes": size,
            "filename": filename,
            "downloadUrl": result["downloadUrl"],
            "downloadUrlExpiresAt": result["expiresAt"],
            "sha256": digest.hexdigest(),
            "method": "r2_link",
        }

    async def _put_part(self, client: httpx.AsyncClient, upload_id: str, number: int, chunk: bytes) -> str:
        last: Exception | None = None
        for attempt in range(1, 5):
            try:
                resp = await client.put(
                    f"{self.base}/part",
                    params={"uploadId": upload_id, "part": number},
                    headers={**self.headers, "Content-Type": "application/octet-stream"},
                    content=chunk,
                )
                if resp.status_code < 300:
                    return str(resp.json()["etag"])
                last = RuntimeError(f"HTTP {resp.status_code}")
                if resp.status_code in (400, 401, 403, 404, 409, 413):
                    break
            except httpx.HTTPError as exc:
                last = exc
            await asyncio.sleep(2**attempt)
        raise MediaError("upload_failed", f"R2 part {number} failed: {last}", retryable=True)

    async def _abort(self, client: httpx.AsyncClient, upload_id: str) -> None:
        try:
            await client.post(f"{self.base}/abort", headers=self.headers, json={"uploadId": upload_id})
        except httpx.HTTPError:
            pass


def sha256_file(path: Path, chunk: int = 4 * 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        while block := fh.read(chunk):
            digest.update(block)
    return digest.hexdigest()


def free_bytes(path: Path) -> int:
    import shutil

    target = path if path.exists() else path.parent
    while not target.exists() and target != target.parent:
        target = target.parent
    return shutil.disk_usage(os.fspath(target)).free
