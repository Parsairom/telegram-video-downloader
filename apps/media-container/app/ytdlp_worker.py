"""Subprocess entry point that runs yt-dlp in isolation.

Protocol:  stdin  = one JSON request
           stdout = JSON lines: {"type":"progress"|"result"|"error", ...}
           stderr = yt-dlp's own log output (captured and used for error classification)

Running yt-dlp in its own process gives us: a hard kill for cancellation/timeouts, crash isolation,
and — importantly — an environment without the bot token or any API key (see security.safe_env).
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

from app.formats import normalise_format


def emit(obj: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


class _Logger:
    """yt-dlp log sink: everything goes to stderr (the parent classifies errors from it) and is also remembered."""

    def __init__(self) -> None:
        self.messages: list[str] = []

    def debug(self, msg: str) -> None:
        if msg.startswith("[debug]"):
            return
        self.messages.append(msg)
        sys.stderr.write(msg + "\n")

    info = debug

    def warning(self, msg: str) -> None:
        self.messages.append(msg)
        sys.stderr.write("WARNING: " + msg + "\n")

    def error(self, msg: str) -> None:
        self.messages.append(msg)
        sys.stderr.write("ERROR: " + msg + "\n")


def base_options(req: dict[str, Any]) -> dict[str, Any]:
    opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "color": "never",
        "logger": _Logger(),  # replaced by download() so it can look at the messages afterwards
        "noplaylist": True,
        "socket_timeout": req.get("socketTimeout", 30),
        "retries": 3,
        "fragment_retries": 5,
        "extractor_retries": 2,
        "geo_bypass": False,  # we do not spoof origin to get around geo restrictions
        "ignoreerrors": False,
        "enable_file_urls": False,
        "cachedir": req.get("cacheDir") or False,
    }
    if req.get("proxy"):
        opts["proxy"] = req["proxy"]
    if req.get("cookiesFile") and Path(req["cookiesFile"]).is_file():
        opts["cookiefile"] = req["cookiesFile"]
    if req.get("jsRuntime"):
        opts["js_runtimes"] = {req["jsRuntime"]: {}}
    # request-level extras an adapter may set (see docs/adding-adapters.md)
    headers = dict(req.get("headers") or {})
    if req.get("referer"):
        headers["Referer"] = str(req["referer"])
    if headers:
        opts["http_headers"] = {str(k): str(v) for k, v in headers.items() if "\n" not in str(v) and "\r" not in str(v)}
    return opts


def _pick_entries(info: dict[str, Any]) -> list[dict[str, Any]]:
    return [e for e in (info.get("entries") or []) if e]


def inspect(req: dict[str, Any]) -> dict[str, Any]:
    from yt_dlp import YoutubeDL

    opts = base_options(req) | {"skip_download": True, "extract_flat": "in_playlist"}
    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(req["url"], download=False)
        if info is None:
            raise RuntimeError("Unable to extract: no information returned")
        info = ydl.sanitize_info(info)

    if info.get("_type") in ("playlist", "multi_video"):
        entries = _pick_entries(info)
        if not entries:
            raise RuntimeError("No video could be found in this playlist")
        listing = []
        for index, entry in enumerate(entries[:25], start=1):
            url = entry.get("webpage_url") or entry.get("url")
            if isinstance(url, str) and url.startswith("http"):
                listing.append(
                    {
                        "index": index,
                        "title": entry.get("title") or entry.get("id") or f"#{index}",
                        "url": url,
                        "durationSeconds": entry.get("duration"),
                    }
                )
        first = entries[0]
        if len(entries) > 1 and listing:
            return {"kind": "playlist", "title": info.get("title"), "entries": listing, "total": len(entries)}
        if first.get("formats"):
            return {"kind": "video", "info": describe(first, req["url"]), "multipleInPost": len(entries) > 1}
        url = first.get("url") or first.get("webpage_url")
        if url:
            return inspect({**req, "url": url})
        raise RuntimeError("No video could be found in this playlist")

    if info.get("_type") == "url" and info.get("url"):
        return inspect({**req, "url": info["url"]})
    return {"kind": "video", "info": describe(info, req["url"])}


def describe(info: dict[str, Any], original_url: str) -> dict[str, Any]:
    duration = info.get("duration")
    formats = []
    drm_seen = False
    for raw in info.get("formats") or []:
        if raw.get("has_drm") or raw.get("drm_systems"):
            drm_seen = True
        norm = normalise_format(raw, duration)
        if norm:
            formats.append(norm)
    if not formats and info.get("url"):  # direct file with no format list
        norm = normalise_format(
            {
                "format_id": "direct",
                "ext": info.get("ext") or "mp4",
                "vcodec": info.get("vcodec"),
                "acodec": info.get("acodec"),
                "width": info.get("width"),
                "height": info.get("height"),
                "filesize": info.get("filesize"),
                "protocol": info.get("protocol"),
            },
            duration,
        )
        if norm:
            formats.append(norm)
    thumbnail = info.get("thumbnail")
    if not thumbnail:
        thumbs = [t for t in (info.get("thumbnails") or []) if t.get("url")]
        thumbnail = thumbs[-1]["url"] if thumbs else None
    return {
        "extractor": info.get("extractor_key") or info.get("extractor") or "generic",
        "site": info.get("extractor") or "generic",
        "originalUrl": original_url,
        "webpageUrl": info.get("webpage_url") or original_url,
        "title": (info.get("title") or info.get("id") or "video").strip(),
        "description": info.get("description"),
        "thumbnail": thumbnail,
        "durationSeconds": duration,
        "uploader": info.get("uploader") or info.get("channel") or info.get("creator"),
        "uploadDate": info.get("upload_date"),
        "isLive": bool(info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming")),
        "drmProtected": drm_seen and not formats,
        "formats": formats,
    }


def make_selector(video_id: str | None, audio_id: str | None):
    """Custom yt-dlp format selector: EXACTLY the requested ids, never a silent substitute."""
    from yt_dlp.utils import ExtractorError

    def selector(ctx: dict[str, Any]):
        by_id = {f["format_id"]: f for f in ctx["formats"]}
        chosen = []
        for fid in (video_id, audio_id):
            if fid is None:
                continue
            if fid not in by_id:
                raise ExtractorError(f"Requested format is not available: {fid}", expected=True)
            chosen.append(by_id[fid])
        if not chosen:
            raise ExtractorError("Requested format is not available: none selected", expected=True)
        if len(chosen) == 1:
            yield chosen[0]
            return
        video, audio = chosen
        yield {
            "format_id": f"{video['format_id']}+{audio['format_id']}",
            "ext": video.get("ext"),
            "requested_formats": chosen,
            "protocol": f"{video.get('protocol')}+{audio.get('protocol')}",
        }

    return selector


def download(req: dict[str, Any]) -> dict[str, Any]:
    from yt_dlp import YoutubeDL

    workdir = Path(req["workdir"])
    workdir.mkdir(parents=True, exist_ok=True)

    def hook(d: dict[str, Any]) -> None:
        total = d.get("total_bytes") or d.get("total_bytes_estimate")
        emit(
            {
                "type": "progress",
                "status": d.get("status"),
                "downloaded": d.get("downloaded_bytes"),
                "total": total,
                "speed": d.get("speed"),
                "eta": d.get("eta"),
                "file": os.path.basename(d.get("filename") or ""),
            }
        )

    opts = base_options(req) | {
        "format": make_selector(req.get("videoFormatId"), req.get("audioFormatId")),
        "outtmpl": str(workdir / "%(id).80B.%(ext)s"),
        "restrictfilenames": True,
        "trim_file_name": 120,
        "overwrites": True,
        "concurrent_fragment_downloads": req.get("fragments", 4),
        "http_chunk_size": 10 * 1024 * 1024,
        "progress_hooks": [hook],
        "keepvideo": False,
        "updatetime": False,
    }
    if req.get("maxFilesize"):
        opts["max_filesize"] = int(req["maxFilesize"])
    if req.get("mergeFormat"):
        opts["merge_output_format"] = req["mergeFormat"]
    if req.get("ffmpeg"):
        opts["ffmpeg_location"] = req["ffmpeg"]
    logger = _Logger()
    opts["logger"] = logger

    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(req["url"], download=True)
        if info is None:
            raise RuntimeError("Download failed: no information returned")
        info = ydl.sanitize_info(info)

    if info.get("_type") in ("playlist", "multi_video"):
        entries = _pick_entries(info)
        info = entries[0] if entries else info
    files = [d["filepath"] for d in (info.get("requested_downloads") or []) if d.get("filepath")]
    if not files and any("max-filesize" in m for m in logger.messages):
        # yt-dlp silently skips a file above max_filesize; surface it as an error instead of "nothing downloaded"
        raise RuntimeError(f"File is larger than max-filesize ({req.get('maxFilesize')} bytes) and was not downloaded")
    return {"files": files, "title": info.get("title"), "durationSeconds": info.get("duration")}


def resolve(req: dict[str, Any]) -> dict[str, Any]:
    """Return a direct media URL (+headers) for one format, used for frame previews."""
    from yt_dlp import YoutubeDL

    opts = base_options(req) | {"skip_download": True}
    with YoutubeDL(opts) as ydl:
        info = ydl.sanitize_info(ydl.extract_info(req["url"], download=False))
    if info.get("_type") in ("playlist", "multi_video"):
        entries = _pick_entries(info)
        info = entries[0] if entries else info
    wanted = req.get("videoFormatId")
    chosen = None
    for f in info.get("formats") or []:
        if f.get("format_id") == wanted:
            chosen = f
            break
    if chosen is None:
        raise RuntimeError(f"Requested format is not available: {wanted}")
    if not chosen.get("url"):
        raise RuntimeError("Unable to extract: format has no direct URL")
    return {
        "url": chosen["url"],
        "headers": chosen.get("http_headers") or {},
        "protocol": chosen.get("protocol"),
        "duration": info.get("duration"),
    }


def main() -> int:
    try:
        req = json.loads(sys.stdin.read())
        mode = req.get("mode")
        handler = {"inspect": inspect, "download": download, "resolve": resolve}.get(mode)
        if handler is None:
            raise RuntimeError(f"unknown mode {mode!r}")
        emit({"type": "result", "data": handler(req)})
        return 0
    except BaseException as exc:  # noqa: BLE001 — everything is reported to the parent
        emit({"type": "error", "message": str(exc) or type(exc).__name__, "exception": type(exc).__name__})
        return 1


if __name__ == "__main__":
    sys.exit(main())
