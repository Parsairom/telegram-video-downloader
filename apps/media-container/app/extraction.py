"""URL inspection: validate -> pick adapter -> yt-dlp metadata -> normalised result."""
from __future__ import annotations

import logging
from typing import Any

import httpx

from .config import Settings
from .download import run_ytdlp
from .errors import MediaError
from .ffmpeg_service import probe_url
from .security import UnsafeUrlError, validate_url
from .source_registry import registry

log = logging.getLogger("tvd.extraction")


def check_url(settings: Settings, url: str) -> str:
    try:
        return validate_url(url, allow_private=settings.allow_private_networks)
    except UnsafeUrlError as exc:
        raise MediaError(exc.code, f"URL rejected: {exc.reason}", retryable=False) from exc


async def _head_size(settings: Settings, url: str) -> int | None:
    """Content-Length of a media URL, fetched through the policy proxy."""
    if not url:
        return None
    try:
        async with httpx.AsyncClient(
            proxy=settings.policy_proxy_url, timeout=httpx.Timeout(15.0), follow_redirects=True, max_redirects=5
        ) as client:
            resp = await client.head(url)
            length = resp.headers.get("content-length")
            return int(length) if length and length.isdigit() else None
    except (httpx.HTTPError, ValueError):
        return None


async def inspect_url(settings: Settings, url: str, correlation_id: str = "") -> dict[str, Any]:
    """Return {"kind": "video", "info": {...}} or {"kind": "playlist", "entries": [...]}."""
    url = check_url(settings, url)
    adapter = registry.select(url)
    request = adapter.customize_request({"mode": "inspect", "url": url})
    log.info("inspect %s adapter=%s cid=%s", _host(url), adapter.name, correlation_id)
    result = await run_ytdlp(settings, request, timeout=120)

    if result.get("kind") == "playlist":
        # entries are URLs the user can pick from; each one is re-validated when it is inspected
        result["entries"] = [e for e in result.get("entries", []) if _entry_ok(settings, e)]
        if not result["entries"]:
            raise MediaError("unsupported_site", "No downloadable videos found in this playlist")
        return result

    info = result["info"]
    if info.get("isLive"):
        raise MediaError("unsupported_site", "Live streams are not supported", retryable=False)
    if info.get("drmProtected"):
        raise MediaError("drm_protected", "This video is DRM-protected and cannot be downloaded", retryable=False)
    if not info.get("formats"):
        raise MediaError("unsupported_site", "No downloadable formats were found", retryable=False)

    class _Ctx:
        async def head_size(self, u: str) -> int | None:
            return await _head_size(settings, u)

        async def probe(self, u: str):
            try:
                return await probe_url(settings, u)
            except MediaError as exc:
                log.info("direct-media probe failed: %s", exc.message)
                return None

    return await adapter.enrich(result, _Ctx())


def _entry_ok(settings: Settings, entry: dict[str, Any]) -> bool:
    try:
        validate_url(entry.get("url", ""), allow_private=settings.allow_private_networks)
        return True
    except UnsafeUrlError:
        return False


def _host(url: str) -> str:
    from urllib.parse import urlsplit

    return urlsplit(url).hostname or "?"
