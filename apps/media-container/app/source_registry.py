"""Pluggable source adapters.

yt-dlp is the universal extraction engine. An adapter adds *site- or URL-class-specific* behaviour on
top of it without touching the rest of the pipeline: extra request options (Referer, headers), result
post-processing (e.g. file sizes from HEAD requests for bare media URLs) and custom error mapping.

To add a site:  subclass `SourceAdapter`, implement `matches`, then `registry.register(MyAdapter())`.
The first adapter that `matches` wins; `YtDlpAdapter` matches everything and is always last.
"""
from __future__ import annotations

import re
from typing import Any, Protocol
from urllib.parse import urlsplit

_MEDIA_EXT = re.compile(r"\.(mp4|m4v|mov|webm|mkv|avi|ts|m3u8|mpd|mp3|m4a|aac|ogg|oga|opus|flac|wav)$", re.I)


class EnrichContext(Protocol):
    """Network helpers an adapter may use while post-processing; both go through the policy proxy."""

    async def head_size(self, url: str) -> int | None: ...

    async def probe(self, url: str) -> Any | None:
        """ffprobe a remote URL; returns an ffmpeg_service.Probe or None if it cannot be read."""
        ...


class SourceAdapter(Protocol):
    name: str

    def matches(self, url: str) -> bool: ...

    def customize_request(self, request: dict[str, Any]) -> dict[str, Any]:
        """Adjust the options handed to the yt-dlp subprocess for this URL."""
        ...

    async def enrich(self, result: dict[str, Any], ctx: EnrichContext) -> dict[str, Any]:
        """Post-process a successful inspect result."""
        ...


class YtDlpAdapter:
    """Default: let yt-dlp's 1000+ extractors decide."""

    name = "yt-dlp"

    def matches(self, url: str) -> bool:
        return True

    def customize_request(self, request: dict[str, Any]) -> dict[str, Any]:
        return request

    async def enrich(self, result: dict[str, Any], ctx: EnrichContext) -> dict[str, Any]:
        return result


class DirectMediaAdapter(YtDlpAdapter):
    """A URL that points straight at a media file or HLS/DASH manifest.

    yt-dlp's generic extractor handles these but reports almost nothing about them (no duration, resolution,
    codecs, often no size). We ask ffprobe (through the policy proxy) so the user sees the REAL resolution,
    duration and codecs, and a HEAD request for the size.
    """

    name = "direct-media"

    def matches(self, url: str) -> bool:
        return bool(_MEDIA_EXT.search(urlsplit(url).path))

    async def enrich(self, result: dict[str, Any], ctx: EnrichContext) -> dict[str, Any]:
        info = result.get("info") or {}
        url = info.get("originalUrl", "")
        probe = await ctx.probe(url)
        formats = info.get("formats", [])
        for fmt in formats:
            if fmt.get("filesize") is None and (fmt.get("protocol") or "http") in ("http", "https"):
                size = await ctx.head_size(url)
                if size:
                    fmt["filesize"] = size
                    fmt["filesizeApprox"] = False
            if probe is not None and len(formats) == 1:  # the generic extractor reports one opaque format
                v, a = probe.video, probe.audio
                if v:
                    fmt.update(kind="video", width=v.width, height=v.height, fps=v.fps, vcodec=v.codec, acodec=a.codec if a else None)
                    fmt["hasAudio"] = a is not None
                elif a:
                    fmt.update(kind="audio", acodec=a.codec, vcodec=None, hasAudio=True)
        if probe is not None and probe.duration:
            info["durationSeconds"] = probe.duration
            if info.get("title") in (None, "", "video"):
                info["title"] = urlsplit(url).path.rsplit("/", 1)[-1] or info.get("title", "video")
        return result


class SourceRegistry:
    def __init__(self) -> None:
        self._adapters: list[SourceAdapter] = []
        self._fallback: SourceAdapter = YtDlpAdapter()

    def register(self, adapter: SourceAdapter) -> None:
        self._adapters.append(adapter)

    def select(self, url: str) -> SourceAdapter:
        for adapter in self._adapters:
            if adapter.matches(url):
                return adapter
        return self._fallback

    @property
    def names(self) -> list[str]:
        return [a.name for a in self._adapters] + [self._fallback.name]


registry = SourceRegistry()
registry.register(DirectMediaAdapter())
