"""Normalise yt-dlp format dictionaries and decide container compatibility.

The Worker shows the user only formats that really exist, so everything here works on the data yt-dlp
reported — nothing is invented.
"""
from __future__ import annotations

from typing import Any

# Codec families (prefix match on yt-dlp's vcodec/acodec strings)
_MP4_VIDEO = ("avc", "h264", "hev", "hvc", "h265", "av01", "av1", "vp9", "vp09", "mp4v", "mpeg4")
_MP4_AUDIO = ("mp4a", "aac", "mp3", "ac-3", "ac3", "ec-3", "eac3", "opus", "flac", "alac")
_WEBM_VIDEO = ("vp8", "vp9", "vp09", "av01", "av1")
_WEBM_AUDIO = ("opus", "vorbis")
_MKV_ANY = True  # Matroska can hold essentially everything we handle

_AUDIO_EXTS = {"mp3", "m4a", "aac", "ogg", "oga", "opus", "flac", "wav", "wma", "weba"}

# Codecs Telegram clients play back inline (used to prefer, never to refuse)
TELEGRAM_FRIENDLY_VIDEO = ("avc", "h264")
TELEGRAM_FRIENDLY_AUDIO = ("mp4a", "aac", "mp3")


def _starts(value: str | None, prefixes: tuple[str, ...]) -> bool:
    v = (value or "").lower()
    return any(v.startswith(p) for p in prefixes)


def container_compat(vcodec: str | None, acodec: str | None, container: str) -> tuple[bool, str | None]:
    """Can these streams be placed in `container` by remuxing (no re-encode)?

    Returns (ok, reason_if_not).
    """
    c = container.lower()
    has_v = vcodec not in (None, "none", "")
    has_a = acodec not in (None, "none", "")
    if c in ("original", "mkv", "mp3", "m4a"):
        if c == "m4a" and has_a and not _starts(acodec, ("mp4a", "aac", "alac", "ac-3", "ac3", "ec-3", "eac3", "mp3")):
            return False, f"audio codec {acodec} cannot be copied into M4A"
        return True, None
    if c == "mp4":
        if has_v and not _starts(vcodec, _MP4_VIDEO):
            return False, f"video codec {vcodec} cannot be copied into MP4"
        if has_a and not _starts(acodec, _MP4_AUDIO):
            return False, f"audio codec {acodec} cannot be copied into MP4"
        return True, None
    if c == "webm":
        if has_v and not _starts(vcodec, _WEBM_VIDEO):
            return False, f"video codec {vcodec} cannot be copied into WebM"
        if has_a and not _starts(acodec, _WEBM_AUDIO):
            return False, f"audio codec {acodec} cannot be copied into WebM"
        return True, None
    return False, f"unknown container {container}"


def _num(value: Any) -> float | int | None:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def normalise_format(fmt: dict[str, Any], duration: float | None) -> dict[str, Any] | None:
    """Convert one yt-dlp format into the MediaFormat shape (packages/shared-types). None = skip."""
    fid = str(fmt.get("format_id") or "")
    if not fid:
        return None
    ext = str(fmt.get("ext") or "")
    protocol = fmt.get("protocol")
    if ext == "mhtml" or (protocol or "").startswith("mhtml"):
        return None  # storyboards
    vcodec = fmt.get("vcodec")
    acodec = fmt.get("acodec")
    if fmt.get("has_drm") or fmt.get("drm_systems"):
        return None  # never offer DRM-protected streams
    if vcodec == "none" and acodec == "none":
        return None
    unknown_streams = vcodec in (None, "") and acodec in (None, "")
    if unknown_streams and not (fmt.get("height") or fmt.get("width")):
        # generic extractor (direct link): nothing is known about the streams, so decide by the container
        # extension; the direct-media adapter then fills in the real codecs/size with ffprobe.
        kind = "audio" if ext in _AUDIO_EXTS else "video"
        has_video, has_audio = kind == "video", True
    else:
        has_video = vcodec != "none" and bool(fmt.get("height") or fmt.get("width") or vcodec not in (None, "none"))
        has_audio = acodec != "none" and not (acodec is None and vcodec not in (None, "none") and fmt.get("audio_channels") == 0)
        kind = "video" if has_video else "audio"

    size = _num(fmt.get("filesize"))
    approx = False
    if not size:
        size = _num(fmt.get("filesize_approx"))
        approx = size is not None
    if not size and _num(fmt.get("tbr")) and duration:
        size = int(fmt["tbr"] * 1000 / 8 * duration)
        approx = True

    note_parts = [fmt.get("format_note"), fmt.get("language") if kind == "audio" else None]
    note = " ".join(str(p) for p in note_parts if p) or None
    return {
        "formatId": fid,
        "ext": ext or "bin",
        "kind": kind,
        "hasAudio": bool(has_audio) if kind == "video" else True,
        "width": _num(fmt.get("width")),
        "height": _num(fmt.get("height")),
        "fps": _num(fmt.get("fps")),
        "vcodec": None if vcodec in (None, "none") else str(vcodec),
        "acodec": None if acodec in (None, "none") else str(acodec),
        "dynamicRange": fmt.get("dynamic_range") if fmt.get("dynamic_range") not in (None, "SDR") else (
            "SDR" if fmt.get("dynamic_range") == "SDR" else None
        ),
        "audioLanguage": fmt.get("language"),
        "audioChannels": _num(fmt.get("audio_channels")),
        "tbr": _num(fmt.get("tbr")),
        "filesize": int(size) if size else None,
        "filesizeApprox": approx,
        "protocol": protocol,
        "note": note,
    }


def build_selector(video_format_id: str | None, audio_format_id: str | None) -> str:
    """yt-dlp `format` string for exactly the chosen format ids — never a silent fallback."""
    for fid in (video_format_id, audio_format_id):
        if fid is not None and not _safe_id(fid):
            raise ValueError(f"unsafe format id: {fid!r}")
    if video_format_id and audio_format_id:
        return f"{video_format_id}+{audio_format_id}"
    if video_format_id:
        return video_format_id
    if audio_format_id:
        return audio_format_id
    raise ValueError("no format id given")


def _safe_id(fid: str) -> bool:
    import re

    return bool(re.fullmatch(r"[A-Za-z0-9_.\-=:@]+", fid))
