"""Thumbnail pipeline: original cover, frame from the video, user-uploaded photo, previews.

Telegram's requirement for an uploaded thumbnail (Bot API sendVideo/sendAudio/sendDocument): a JPEG,
at most 200 kB, at most 320 px on either side. `to_telegram_thumbnail` produces and *validates* that.
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path

import httpx
from PIL import Image, ImageOps, ImageStat

from .config import Settings
from .errors import JobCancelled
from .ffmpeg_service import extract_frame

log = logging.getLogger("tvd.thumbnails")

THUMB_MAX_BYTES = 200 * 1024
THUMB_TARGET_BYTES = 190 * 1024
THUMB_MAX_SIDE = 320


def _convert_sync(src: Path, dst: Path, max_side: int, max_bytes: int | None) -> bool:
    try:
        with Image.open(src) as img:
            img.load()
            img = ImageOps.exif_transpose(img).convert("RGB")
            img.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
            quality = 88
            while True:
                img.save(dst, "JPEG", quality=quality, optimize=True)
                if max_bytes is None or dst.stat().st_size <= max_bytes or quality <= 35:
                    break
                quality -= 8
        return True
    except Exception as exc:  # noqa: BLE001 — a corrupt cover is not fatal
        log.info("image conversion failed for %s: %s", src.name, exc)
        return False


async def to_telegram_thumbnail(src: Path, dst: Path) -> Path | None:
    """Convert any image into a Telegram-valid thumbnail; returns None when the result would not validate."""
    ok = await asyncio.to_thread(_convert_sync, src, dst, THUMB_MAX_SIDE, THUMB_TARGET_BYTES)
    if not ok or not validate_thumbnail(dst)[0]:
        dst.unlink(missing_ok=True)
        return None
    return dst


async def to_preview_photo(src: Path, dst: Path) -> Path | None:
    """JPEG up to 1280px for showing in a chat."""
    ok = await asyncio.to_thread(_convert_sync, src, dst, 1280, 4 * 1024 * 1024)
    return dst if ok else None


def validate_thumbnail(path: Path) -> tuple[bool, str | None]:
    """True when `path` meets Telegram's thumbnail rules."""
    try:
        size = path.stat().st_size
    except OSError:
        return False, "file missing"
    if size <= 0 or size >= THUMB_MAX_BYTES:
        return False, f"size {size} bytes is not under 200 kB"
    try:
        with Image.open(path) as img:
            if img.format != "JPEG":
                return False, f"format {img.format} is not JPEG"
            if img.width > THUMB_MAX_SIDE or img.height > THUMB_MAX_SIDE:
                return False, f"dimensions {img.width}x{img.height} exceed {THUMB_MAX_SIDE}px"
            if img.width < 1 or img.height < 1:
                return False, "empty image"
    except Exception as exc:  # noqa: BLE001
        return False, f"unreadable image: {exc}"
    return True, None


def frame_is_usable(path: Path) -> bool:
    """Reject empty / black / flat frames."""
    try:
        if path.stat().st_size < 2500:
            return False
        with Image.open(path) as img:
            stat = ImageStat.Stat(img.convert("L"))
            return stat.mean[0] > 12 and stat.stddev[0] > 6
    except Exception:  # noqa: BLE001
        return False


def _crop_to_ratio(src: Path, dst: Path, ratio: float) -> Path:
    """Centre-crop a cover to the video's aspect ratio (removes e.g. YouTube's letter-box bars)."""
    with Image.open(src) as img:
        img = img.convert("RGB")
        current = img.width / img.height
        if abs(current - ratio) / ratio > 0.03:
            if current > ratio:
                new_w = int(round(img.height * ratio))
                left = (img.width - new_w) // 2
                img = img.crop((left, 0, left + new_w, img.height))
            else:
                new_h = int(round(img.width / ratio))
                top = (img.height - new_h) // 2
                img = img.crop((0, top, img.width, top + new_h))
        img.save(dst, "JPEG", quality=92)
    return dst


async def fetch_image(settings: Settings, url: str, dst: Path) -> Path | None:
    """Download a cover image through the policy proxy (so it cannot be used to reach internal hosts)."""
    try:
        async with httpx.AsyncClient(
            proxy=settings.policy_proxy_url, timeout=httpx.Timeout(20.0), follow_redirects=True, max_redirects=4
        ) as client:
            async with client.stream("GET", url, headers={"User-Agent": "Mozilla/5.0"}) as resp:
                resp.raise_for_status()
                total = 0
                with dst.open("wb") as fh:
                    async for chunk in resp.aiter_bytes():
                        total += len(chunk)
                        if total > 12 * 1024 * 1024:
                            raise ValueError("cover image too large")
                        fh.write(chunk)
        return dst
    except (httpx.HTTPError, ValueError, OSError) as exc:
        log.info("cover download failed: %s", exc)
        dst.unlink(missing_ok=True)
        return None


async def fetch_telegram_photo(settings: Settings, file_id: str, dst: Path) -> Path | None:
    """Download a user-uploaded photo via getFile (Bot API cloud download limit: 20 MB)."""
    if not settings.bot_token:
        return None
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0), proxy=settings.telegram_proxy) as client:
            meta = await client.post(f"{settings.telegram_api_base}/bot{settings.bot_token}/getFile", json={"file_id": file_id})
            data = meta.json()
            if not data.get("ok"):
                return None
            file_path = data["result"]["file_path"]
            if file_path.startswith("/"):  # local Bot API server returns an absolute path on disk
                src = Path(file_path)
                if src.is_file():
                    dst.write_bytes(src.read_bytes())
                    return dst
                return None
            async with client.stream("GET", f"{settings.telegram_api_base}/file/bot{settings.bot_token}/{file_path}") as resp:
                resp.raise_for_status()
                with dst.open("wb") as fh:
                    async for chunk in resp.aiter_bytes():
                        fh.write(chunk)
        return dst
    except (httpx.HTTPError, KeyError, ValueError, OSError) as exc:
        log.info("telegram photo download failed: %s", type(exc).__name__)
        dst.unlink(missing_ok=True)
        return None


async def build_thumbnail(
    settings: Settings,
    *,
    mode: str,
    video: Path | None,
    workdir: Path,
    cover_url: str | None,
    custom_file_id: str | None,
    frame_timestamp: float | None,
    duration: float | None,
    width: int | None,
    height: int | None,
    cancel: asyncio.Event | None = None,
) -> Path | None:
    """Create the final Telegram-valid thumbnail for the chosen mode. Returns None if none could be built."""
    out = workdir / "thumb.jpg"
    if mode == "none":
        return None

    async def from_frame() -> Path | None:
        if video is None:
            return None
        base = frame_timestamp if frame_timestamp is not None else min((duration or 0) * 0.1, 10.0)
        candidates = [base] + [t for t in (0.5, 1.0, (duration or 4) * 0.25, (duration or 8) * 0.5) if t != base]
        for ts in candidates:
            raw = workdir / "frame.jpg"
            if cancel and cancel.is_set():
                raise JobCancelled()
            if await extract_frame(settings, str(video), ts, raw) and frame_is_usable(raw):
                result = await to_telegram_thumbnail(raw, out)
                raw.unlink(missing_ok=True)
                if result:
                    return result
            raw.unlink(missing_ok=True)
        return None

    if mode == "frame":
        return await from_frame()

    if mode == "custom" and custom_file_id:
        raw = await fetch_telegram_photo(settings, custom_file_id, workdir / "custom.raw")
        if raw:
            result = await to_telegram_thumbnail(raw, out)
            raw.unlink(missing_ok=True)
            if result:
                return result
        log.info("custom thumbnail unusable, falling back to a video frame")
        return await from_frame()

    # mode == "original" (and fallback)
    if cover_url:
        raw = await fetch_image(settings, cover_url, workdir / "cover.raw")
        if raw:
            source: Path = raw
            if width and height:
                with Image.open(raw) as img:
                    cover_ratio = img.width / img.height
                video_ratio = width / height
                spread = max(cover_ratio / video_ratio, video_ratio / cover_ratio)
                if spread > 1.5:
                    raw.unlink(missing_ok=True)
                    return await from_frame()  # cover does not match the video at all
                if spread > 1.03:
                    source = _crop_to_ratio(raw, workdir / "cover.crop.jpg", video_ratio)
            result = await to_telegram_thumbnail(source, out)
            for p in {raw, source}:
                p.unlink(missing_ok=True)
            if result:
                return result
    return await from_frame()


async def preview_frames(
    settings: Settings,
    media_url: str,
    headers: dict[str, str],
    duration: float,
    workdir: Path,
    *,
    count: int = 5,
    cancel: asyncio.Event | None = None,
) -> list[tuple[float, Path]]:
    """Frames at evenly spaced timestamps from a remote stream (through the policy proxy), usable ones only."""
    workdir.mkdir(parents=True, exist_ok=True)
    stamps = [duration * (i + 1) / (count + 1) for i in range(count)]
    results: list[tuple[float, Path]] = []
    for i, ts in enumerate(stamps):
        raw = workdir / f"prev_raw_{i}.jpg"
        out = workdir / f"prev_{i}.jpg"
        if await extract_frame(
            settings, media_url, ts, raw, proxy=settings.policy_proxy_url, headers=headers, timeout=45, cancel=cancel
        ) and frame_is_usable(raw):
            if await to_preview_photo(raw, out):
                results.append((ts, out))
        raw.unlink(missing_ok=True)
    return results
