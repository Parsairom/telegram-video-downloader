"""Upload through MTProto (Telethon) as the same bot: files up to ~2000 MB instead of the Bot API's 50 MB.

Why this instead of a local Bot API server: no extra server binary, no `logOut` from the cloud API (the webhook keeps
working), and no state that must survive restarts except a small session file. A bot account can open an MTProto session
with its token plus API credentials (my.telegram.org); sending files that way is allowed up to 2000 MB.

Peer resolution: an MTProto session can only address a user whose access hash it has seen. The long-lived client below
stays connected, so every user who messages the bot is cached from the live update stream (and missed updates are fetched
on start-up). If a user is still unknown we try access_hash 0 and otherwise report a precise error.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from .config import Settings
from .errors import MediaError

log = logging.getLogger("tvd.mtproto")

ProgressFn = Callable[[int, int], None]


def telethon_proxy(proxy_url: str | None) -> tuple | None:
    """socks5://user:pass@host:port | socks4://… | http://… → Telethon's proxy tuple (remote DNS)."""
    if not proxy_url:
        return None
    u = urlparse(proxy_url)
    kind = {"socks5": "socks5", "socks5h": "socks5", "socks4": "socks4", "socks4a": "socks4", "http": "http", "https": "http"}.get(
        u.scheme.lower()
    )
    if not kind or not u.hostname or not u.port:
        raise ValueError(f"unsupported proxy URL: {proxy_url!r}")
    return (kind, u.hostname, u.port, True, unquote(u.username) if u.username else None, unquote(u.password) if u.password else None)


class MtprotoSender:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._client: Any | None = None
        self._lock = asyncio.Lock()

    @property
    def available(self) -> bool:
        return self.settings.mtproto_enabled

    @property
    def connected(self) -> bool:
        return bool(self._client is not None and self._client.is_connected())

    async def start(self) -> bool:
        """Connect and log the bot in (also what keeps the peer cache warm). Never raises."""
        if not self.available:
            return False
        try:
            await self._ensure_client()
            return True
        except Exception as exc:  # noqa: BLE001 — start-up must not fail because Telegram is unreachable
            log.warning("MTProto client could not start (will retry on the first upload): %s", type(exc).__name__)
            return False

    async def _ensure_client(self):
        async with self._lock:
            if self._client is not None and self._client.is_connected():
                return self._client
            from telethon import TelegramClient

            s = self.settings
            self.settings.mtproto_session.parent.mkdir(parents=True, exist_ok=True)
            client = TelegramClient(
                str(s.mtproto_session),
                int(s.telegram_api_id or 0),
                s.telegram_api_hash or "",
                proxy=telethon_proxy(s.telegram_proxy),
                connection_retries=5,
                retry_delay=2,
                auto_reconnect=True,
                request_retries=3,
            )
            await client.start(bot_token=s.bot_token)
            self._client = client
            log.info("MTProto session ready")
            return client

    async def close(self) -> None:
        client, self._client = self._client, None
        if client is not None:
            with contextlib.suppress(Exception):
                await client.disconnect()

    async def _peer(self, client, chat_id: int):
        from telethon.tl.types import InputPeerUser

        try:
            return await client.get_input_entity(chat_id)
        except ValueError:
            # not seen yet: a bot may address a user who has started it with access_hash 0
            return InputPeerUser(user_id=chat_id, access_hash=0)

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
        from telethon import errors
        from telethon.tl.types import DocumentAttributeAudio, DocumentAttributeVideo

        size = path.stat().st_size
        if size > self.settings.mtproto_upload_limit_bytes:
            raise MediaError(
                "too_large",
                f"file is {size} bytes, above the MTProto limit of {self.settings.mtproto_upload_limit_bytes} bytes",
                retryable=False,
            )
        as_video = kind == "video" and send_as != "document" and (
            send_as == "video" or (container in ("mp4", "original") and path.suffix.lower() in (".mp4", ".m4v", ".mov"))
        )
        if kind == "audio":
            attributes: list[Any] = [
                DocumentAttributeAudio(duration=int(round(duration or 0)), title=(title or "")[:100] or None, performer=(performer or "")[:100] or None)
            ]
        elif as_video:
            attributes = [DocumentAttributeVideo(duration=float(round(duration or 0, 2)), w=width or 1280, h=height or 720, supports_streaming=True)]
        else:
            attributes = []

        def _errs(*names: str) -> tuple[type[BaseException], ...]:
            return tuple(getattr(errors, n) for n in names if hasattr(errors, n))

        too_large_errors = _errs("FilePartsInvalidError", "FilePartTooBigError", "FilePartSizeInvalidError")
        undeliverable_errors = _errs("PeerIdInvalidError", "InputUserDeactivatedError", "UserIsBlockedError", "ChatWriteForbiddenError")
        last: Exception | None = None
        for attempt in range(1, 4):
            try:
                client = await self._ensure_client()
                peer = await self._peer(client, chat_id)
                kwargs: dict[str, Any] = {
                    "caption": caption,
                    "parse_mode": "html",
                    "force_document": not as_video and kind != "audio",
                    "attributes": attributes or None,
                    "thumb": str(thumb) if thumb else None,
                    "progress_callback": on_progress,
                    "reply_to": reply_to,
                }
                message = await asyncio.wait_for(client.send_file(peer, str(path), **kwargs), timeout=upload_timeout)
                return {
                    "telegramMessageId": getattr(message, "id", None),
                    "telegramFileId": None,  # MTProto ids differ from Bot API file_ids
                    "sizeBytes": size,
                    "filename": filename,
                    "durationSeconds": duration,
                    "width": width,
                    "height": height,
                    "downloadUrl": None,
                    "downloadUrlExpiresAt": None,
                    "sha256": None,
                    "method": "mtproto",
                }
            except errors.FloodWaitError as exc:
                last = exc
                wait = float(getattr(exc, "seconds", 5))
                log.info("MTProto flood wait %ss", wait)
                if attempt < 3 and wait <= 120:
                    await asyncio.sleep(wait + 1)
                    continue
                raise MediaError("rate_limited", f"Telegram asked us to wait {int(wait)}s", retryable=True) from exc
            except too_large_errors as exc:
                raise MediaError("too_large", "Telegram rejected the file size", retryable=False) from exc
            except undeliverable_errors as exc:
                raise MediaError(
                    "telegram_error",
                    f"Telegram cannot deliver to this chat ({type(exc).__name__}). The user must message the bot while the engine is online.",
                    retryable=False,
                ) from exc
            except TimeoutError as exc:
                last = exc
                break
            except (ConnectionError, OSError) as exc:
                last = exc
                await self.close()
                await asyncio.sleep(2**attempt)
        raise MediaError("upload_failed", f"MTProto upload failed: {type(last).__name__ if last else 'unknown'}", retryable=True)
