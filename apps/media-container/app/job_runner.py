"""Orchestrates one download job: precheck -> download -> merge/remux -> validate -> thumbnail -> deliver."""
from __future__ import annotations

import asyncio
import contextlib
import logging
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import ffmpeg_service as ff
from .callbacks import Reporter
from .config import Settings
from .delivery import R2LinkUploader, TelegramSender, free_bytes, sha256_file
from .download import run_ytdlp
from .errors import JobCancelled, MediaError
from .extraction import check_url
from .formats import container_compat
from .metadata import human_duration, human_size, render_caption, safe_filename
from .models import StartJobRequest
from .mtproto import MtprotoSender
from .thumbnails import build_thumbnail

log = logging.getLogger("tvd.job")

_JUNK_SUFFIXES = {".part", ".ytdl", ".json", ".jpg", ".jpeg", ".png", ".webp", ".vtt", ".srt", ".temp"}


@dataclass
class JobState:
    job_id: str
    state: str = "running"  # running | completed | failed | cancelled
    phase: str | None = None
    progress: dict[str, Any] | None = None
    result: dict[str, Any] | None = None
    error_code: str | None = None
    message: str | None = None
    started_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return {
            "jobId": self.job_id,
            "state": self.state,
            "phase": self.phase,
            "progress": self.progress,
            "result": self.result,
            "errorCode": self.error_code,
            "message": self.message,
        }


def merge_format(sel) -> str | None:
    """Container for yt-dlp's merge step (only used when video and audio are separate streams)."""
    if not (sel.videoFormatId and sel.audioFormatId):
        return None
    if sel.container in ("mp4", "webm", "mkv"):
        ok, _ = container_compat(sel.videoCodec, sel.audioCodec, sel.container)
        return sel.container if ok else "mkv"  # mkv holds anything losslessly; final pass converts if allowed
    ok, _ = container_compat(sel.videoCodec, sel.audioCodec, "mp4")
    return "mp4" if ok else "mkv"


class JobRunner:
    def __init__(
        self,
        settings: Settings,
        req: StartJobRequest,
        reporter: Reporter,
        cancel: asyncio.Event,
        mtproto: MtprotoSender | None = None,
    ):
        self.s = settings
        self.mtproto = mtproto
        self.req = req
        self.sel = req.selection
        self.reporter = reporter
        self.cancel = cancel
        self.state = JobState(job_id=req.jobId)
        self.workdir = settings.work_dir / req.jobId
        self._dl_files: dict[str, tuple[int, int]] = {}
        self._tasks: set[asyncio.Task] = set()
        self._upload_started = 0.0
        self.shutting_down = False  # set by JobManager.shutdown() on SIGTERM

    # ───────────────────────── public ─────────────────────────
    async def run(self) -> None:
        self.reporter.start_heartbeat()
        try:
            self._precheck()
            self._phase("downloading")
            await self.reporter.state("downloading")
            files = await self._download()
            self._check_cancel()

            self._phase("processing")
            await self.reporter.state("processing")
            final, pr = await self._process(files)
            self._check_cancel()
            thumb = await self._thumbnail(final, pr)
            self._check_cancel()

            self._phase("uploading")
            await self.reporter.state("uploading")
            result = await self._deliver(final, pr, thumb)
            self.state.result = result
            self.state.state = "completed"
            await self.reporter.completed(result)
        except JobCancelled:
            if self.shutting_down:  # container is stopping: let the Worker retry on a fresh instance
                self.state.state, self.state.error_code = "failed", "container_lost"
                self.state.message = "the media container was restarted"
                await self.reporter.failed("container_lost", "the media container is shutting down", True)
            else:
                self.state.state, self.state.error_code, self.state.message = "cancelled", "cancelled", "cancelled"
                await self.reporter.failed("cancelled", "cancelled by the user", False)
        except MediaError as exc:
            log.warning("job %s failed: %s %s", self.req.jobId, exc.code, exc.message)
            self.state.state, self.state.error_code, self.state.message = "failed", exc.code, exc.message
            await self.reporter.failed(exc.code, exc.message, exc.retryable)
        except Exception as exc:  # noqa: BLE001
            log.exception("job %s crashed", self.req.jobId)
            self.state.state, self.state.error_code, self.state.message = "failed", "internal", type(exc).__name__
            await self.reporter.failed("internal", f"internal error: {type(exc).__name__}", False)
        finally:
            for task in list(self._tasks):
                task.cancel()
            await self.reporter.close()
            await self._cleanup()

    # ───────────────────────── steps ─────────────────────────
    def _phase(self, phase: str) -> None:
        self.state.phase = phase

    def _check_cancel(self) -> None:
        if self.cancel.is_set():
            raise JobCancelled()

    def _precheck(self) -> None:
        s, req, sel, limits = self.s, self.req, self.sel, self.req.limits
        check_url(s, req.url)
        if limits.maxDurationSeconds and (req.meta.durationSeconds or 0) > limits.maxDurationSeconds:
            raise MediaError(
                "too_long",
                f"video is {human_duration(req.meta.durationSeconds)} long; the limit is {human_duration(limits.maxDurationSeconds)}",
                retryable=False,
            )
        mode_limit = {
            "bot_api_cloud": s.cloud_upload_limit_bytes,
            "bot_api_local": s.local_upload_limit_bytes,
            "mtproto": s.mtproto_upload_limit_bytes,
            "r2_link": limits.maxOutputBytes,
        }[sel.deliveryMode]
        # with the automatic policy an over-limit file becomes a download link, so only the global ceiling applies
        ceiling = limits.maxOutputBytes if sel.allowLinkFallback else min(limits.maxOutputBytes, mode_limit)
        if sel.estimatedBytes and sel.estimatedBytes > ceiling * 1.15:
            raise MediaError(
                "too_large",
                f"estimated size {human_size(sel.estimatedBytes)} exceeds the {human_size(ceiling)} limit for this delivery mode",
                retryable=False,
            )
        if sel.deliveryMode != "r2_link" and not s.bot_token:
            raise MediaError("telegram_error", "BOT_TOKEN is not configured in the container", retryable=False)
        if sel.deliveryMode == "mtproto" and not (self.mtproto and self.mtproto.available):
            raise MediaError(
                "telegram_error", "MTProto upload is not enabled in this engine (TELEGRAM_API_ID / TELEGRAM_API_HASH missing)", retryable=False
            )
        if sel.deliveryMode == "bot_api_local" and not s.local_bot_api_enabled:
            raise MediaError(
                "telegram_error", "the local Bot API server is not enabled in this container", retryable=False
            )
        if sel.kind == "video" and sel.container in ("mp4", "webm") and not sel.allowTranscode:
            ok, reason = container_compat(sel.videoCodec, sel.audioCodec, sel.container)
            if not ok:
                raise MediaError("format_unavailable", f"{reason}; re-encoding was not allowed", retryable=False)

        # disk: download parts + merge + final copy can briefly need ~2.3x the output size
        need = int(max(sel.estimatedBytes or 0, 50 * 1024 * 1024) * 2.3) + s.min_free_disk_bytes
        s.work_dir.mkdir(parents=True, exist_ok=True)
        free = free_bytes(s.work_dir)
        if free < need:
            raise MediaError(
                "disk_full",
                f"not enough free disk in the container: {human_size(free)} free, about {human_size(need)} needed",
                retryable=True,
            )
        if need - s.min_free_disk_bytes > limits.maxTempBytes:
            raise MediaError("disk_full", "job would exceed the configured temporary storage limit", retryable=False)

    async def _download(self) -> list[Path]:
        sel, limits = self.sel, self.req.limits
        src_dir = self.workdir / "src"
        src_dir.mkdir(parents=True, exist_ok=True)
        expected = sel.estimatedBytes or 0

        def on_progress(msg: dict[str, Any]) -> None:
            name = msg.get("file") or "?"
            done = int(msg.get("downloaded") or 0)
            total = int(msg.get("total") or 0)
            if msg.get("status") == "finished":
                total = done = done or total
            self._dl_files[name] = (done, total)
            got = sum(d for d, _ in self._dl_files.values())
            known = sum(t for _, t in self._dl_files.values())
            overall = max(expected, known, got)
            payload = {
                "phase": "downloading",
                "percent": min(got / overall * 100, 99.0) if overall else None,
                "speedBytesPerSec": msg.get("speed"),
                "etaSeconds": msg.get("eta"),
                "downloadedBytes": got,
                "totalBytes": overall or None,
                "detail": "video+audio" if sel.videoFormatId and sel.audioFormatId else None,
            }
            self.state.progress = payload
            self._spawn(self.reporter.progress(payload))

        request = {
            "mode": "download",
            "url": self.req.url,
            "workdir": str(src_dir),
            "videoFormatId": sel.videoFormatId,
            "audioFormatId": sel.audioFormatId,
            "mergeFormat": merge_format(sel),
            "maxFilesize": limits.maxOutputBytes,
        }
        # yt-dlp's --max-filesize only works for plain HTTP downloads with a known Content-Length, so we also
        # watch the folder: DASH/HLS downloads of unknown size are aborted as soon as they exceed the limit.
        dl_cancel = asyncio.Event()
        oversize = False
        hard_limit = int(limits.maxOutputBytes * 1.25) + 50 * 1024 * 1024

        async def forward_cancel() -> None:
            await self.cancel.wait()
            dl_cancel.set()

        async def watch_size() -> None:
            nonlocal oversize
            while True:
                await asyncio.sleep(2)
                used = await asyncio.to_thread(_dir_size, src_dir)
                if used > hard_limit:
                    oversize = True
                    dl_cancel.set()
                    return

        helpers = [asyncio.ensure_future(forward_cancel()), asyncio.ensure_future(watch_size())]
        try:
            data = await run_ytdlp(
                self.s, request, timeout=limits.downloadTimeoutSeconds, on_progress=on_progress, cancel=dl_cancel
            )
        except JobCancelled:
            if oversize:
                raise MediaError(
                    "too_large", f"the download exceeded the {human_size(limits.maxOutputBytes)} limit and was stopped",
                    retryable=False,
                ) from None
            raise
        finally:
            for helper in helpers:
                helper.cancel()
        files = [Path(p) for p in data.get("files", []) if Path(p).is_file()]
        if not files:
            files = [p for p in src_dir.rglob("*") if p.is_file() and p.suffix.lower() not in _JUNK_SUFFIXES]
        if not files:
            raise MediaError("network_error", "the download finished but produced no file", retryable=True)
        return files

    async def _process(self, files: list[Path]) -> tuple[Path, ff.Probe]:
        sel, req, limits = self.sel, self.req, self.req.limits
        src = max(files, key=lambda p: p.stat().st_size)
        pr = await ff.probe(self.s, src)
        out_dir = self.workdir / "out"
        out_dir.mkdir(parents=True, exist_ok=True)
        timeout = limits.processingTimeoutSeconds

        def on_percent(pct: float) -> None:
            payload = {
                "phase": "processing", "percent": pct, "speedBytesPerSec": None, "etaSeconds": None,
                "downloadedBytes": None, "totalBytes": None, "detail": "ffmpeg",
            }
            self.state.progress = payload
            self._spawn(self.reporter.progress(payload))

        base_name = sel.filename or sel.title or req.meta.title
        if sel.kind == "video":
            if pr.video is None:
                raise MediaError("validation_failed", "the downloaded file has no video stream", retryable=False)
            plan = ff.plan_streams(pr, sel.container, sel.allowTranscode)
            ext = src.suffix if sel.container == "original" else ff.container_extension(sel.container, src)
            dst = out_dir / safe_filename(base_name, ext)
            await ff.finalize_video(
                self.s, src, dst, container=sel.container, plan=plan, pr=pr, title=sel.embedTitle,
                artist=sel.embedArtist, timeout=timeout, cancel=self.cancel, on_percent=on_percent,
            )
            container_for_validation = sel.container if sel.container != "original" else _container_of(dst)
        else:
            container = sel.container if sel.container in ("mp3", "m4a") else "original"
            ext = ff.container_extension(container, src) if container != "original" else src.suffix
            dst = out_dir / safe_filename(base_name, ext)
            await ff.finalize_audio(
                self.s, src, dst, container=container, pr=pr, title=sel.embedTitle or sel.title or req.meta.title,
                artist=sel.embedArtist or req.meta.uploader, timeout=timeout, cancel=self.cancel, on_percent=on_percent,
            )
            container_for_validation = container if container != "original" else _container_of(dst)

        for f in files:
            f.unlink(missing_ok=True)
        report = await ff.validate_output(
            self.s, dst, kind=sel.kind, container=container_for_validation, max_bytes=limits.maxOutputBytes,
            expected_height_short_side=sel.expectedHeight if sel.kind == "video" else None,
            source_duration=req.meta.durationSeconds,
        )
        for warning in report.warnings:
            log.info("job %s validation warning: %s", req.jobId, warning)
        if not report.ok:
            reason = "; ".join(report.errors)
            code = "too_large" if "above the configured limit" in reason else "validation_failed"
            raise MediaError(code, f"output validation failed: {reason}", retryable=False)
        assert report.probe is not None
        return dst, report.probe

    async def _thumbnail(self, final: Path, pr: ff.Probe) -> Path | None:
        sel, req = self.sel, self.req
        mode = sel.thumbnail.mode
        if sel.kind == "audio" and mode == "frame":
            mode = "original"
        v = pr.video
        return await build_thumbnail(
            self.s,
            mode=mode,
            video=final if sel.kind == "video" else None,
            workdir=self.workdir,
            cover_url=req.meta.thumbnailUrl,
            custom_file_id=sel.thumbnail.customFileId,
            frame_timestamp=sel.thumbnail.frameTimestamp,
            duration=pr.duration,
            width=v.width if v else None,
            height=v.height if v else None,
            cancel=self.cancel,
        )

    async def _deliver(self, final: Path, pr: ff.Probe, thumb: Path | None) -> dict[str, Any]:
        sel, req, meta = self.sel, self.req, self.req.meta
        v = pr.video
        size = final.stat().st_size
        resolution = f"{v.width}×{v.height}" if v and v.width and v.height else (sel.label or "")
        caption = render_caption(
            sel.caption,
            {
                "title": sel.title or meta.title, "site": meta.site, "duration": human_duration(pr.duration),
                "resolution": resolution, "size": human_size(size), "url": meta.webpageUrl or req.url,
                "uploader": meta.uploader or "", "date": meta.uploadDate or "", "filename": final.name,
            },
        )
        self._upload_started = time.monotonic()

        def on_upload(sent: int, total: int) -> None:
            elapsed = max(time.monotonic() - self._upload_started, 0.001)
            speed = sent / elapsed
            payload = {
                "phase": "uploading", "percent": sent / total * 100 if total else None,
                "speedBytesPerSec": speed, "etaSeconds": (total - sent) / speed if speed else None,
                "downloadedBytes": sent, "totalBytes": total, "detail": None,
            }
            self.state.progress = payload
            self._spawn(self.reporter.progress(payload))

        digest = await asyncio.to_thread(sha256_file, final)

        mode = sel.deliveryMode
        mode_limit = {
            "bot_api_cloud": self.s.cloud_upload_limit_bytes,
            "bot_api_local": self.s.local_upload_limit_bytes,
            "mtproto": self.s.mtproto_upload_limit_bytes,
        }.get(mode)
        if mode_limit is not None and size > mode_limit and sel.allowLinkFallback:
            # automatic policy: prefer a bigger Telegram mechanism, then a link — never fail a finished file
            if mode == "bot_api_cloud" and self.mtproto and self.mtproto.available and size <= self.s.mtproto_upload_limit_bytes:
                log.info("job %s: %s bytes exceeds the Bot API limit, switching to MTProto", req.jobId, size)
                mode = "mtproto"
            else:
                log.info("job %s: %s > %s limit for %s, delivering a download link instead", req.jobId, size, mode_limit, mode)
                mode = "r2_link"

        async def go() -> dict[str, Any]:
            if mode == "r2_link":
                uploader = R2LinkUploader(req.callback.baseUrl, req.jobId, req.callback.token, req.correlationId)
                fields = await uploader.upload(final, final.name, on_upload)
            else:
                sender = (
                    self.mtproto
                    if mode == "mtproto" and self.mtproto is not None
                    else TelegramSender(self.s, local=(mode == "bot_api_local"))
                )
                fields = await sender.send(
                    chat_id=req.chatId, path=final, kind=sel.kind, send_as=sel.sendAs, container=sel.container,
                    caption=caption, filename=final.name, thumb=thumb, reply_to=req.replyToMessageId,
                    duration=pr.duration, width=v.width if v else None, height=v.height if v else None,
                    title=sel.embedTitle or sel.title or meta.title, performer=sel.embedArtist or meta.uploader,
                    upload_timeout=req.limits.uploadTimeoutSeconds,
                    on_progress=on_upload if mode in ("bot_api_cloud", "mtproto") else None,
                )
            return {
                "mode": mode,
                "telegramMessageId": fields.get("telegramMessageId"),
                "telegramFileId": fields.get("telegramFileId"),
                "sizeBytes": size,
                "filename": final.name,
                "durationSeconds": pr.duration,
                "width": v.width if v else None,
                "height": v.height if v else None,
                "downloadUrl": fields.get("downloadUrl"),
                "downloadUrlExpiresAt": fields.get("downloadUrlExpiresAt"),
                "sha256": digest,
            }

        task = asyncio.ensure_future(go())
        cancel_wait = asyncio.ensure_future(self.cancel.wait())
        try:
            done, _ = await asyncio.wait({task, cancel_wait}, return_when=asyncio.FIRST_COMPLETED)
            if task in done:
                return task.result()
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
            raise JobCancelled()
        finally:
            cancel_wait.cancel()

    # ───────────────────────── helpers ─────────────────────────
    def _spawn(self, coro) -> None:
        task = asyncio.ensure_future(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _cleanup(self) -> None:
        for _ in range(5):
            await asyncio.to_thread(shutil.rmtree, self.workdir, True)
            if not self.workdir.exists():
                return
            await asyncio.sleep(1.0)
        log.warning("could not fully remove %s", self.workdir)


def _dir_size(path: Path) -> int:
    total = 0
    for p in path.rglob("*"):
        with contextlib.suppress(OSError):
            if p.is_file():
                total += p.stat().st_size
    return total


def _container_of(path: Path) -> str:
    return {
        ".mp4": "mp4", ".m4v": "mp4", ".mov": "mp4", ".m4a": "m4a", ".mp3": "mp3", ".webm": "webm", ".mkv": "mkv",
    }.get(path.suffix.lower(), "original")
