"""Opt-in compatibility checks against REAL sites (metadata only, nothing is downloaded).

Run before upgrading yt-dlp (docs/updating-dependencies.md):

    TVD_EXTRACTOR_URLS="https://www.youtube.com/watch?v=jNQXAC9IVRw,https://vimeo.com/1084537" \\
        python -m pytest tests/test_network_extractors.py -m network -q

Requires direct outbound internet access from this machine (the policy proxy connects directly). Skipped otherwise.
"""
from __future__ import annotations

import dataclasses
import os

import pytest

from app.extraction import inspect_url
from app.security import PolicyProxy

URLS = [u.strip() for u in os.environ.get("TVD_EXTRACTOR_URLS", "").split(",") if u.strip()]

pytestmark = [pytest.mark.network, pytest.mark.skipif(not URLS, reason="set TVD_EXTRACTOR_URLS to run real-site checks")]


@pytest.mark.parametrize("url", URLS or ["https://example.invalid/"])
async def test_site_still_extracts(settings, url):
    proxy = PolicyProxy(port=0)
    port = await proxy.start()
    try:
        s = dataclasses.replace(settings, policy_proxy_port=port)
        result = await inspect_url(s, url, "network-check")
    finally:
        await proxy.stop()
    assert result["kind"] in ("video", "playlist")
    if result["kind"] == "video":
        info = result["info"]
        assert info["title"] and info["formats"], "extractor returned no formats"
        heights = {f["height"] for f in info["formats"] if f["kind"] == "video" and f["height"]}
        print(f"\n{info['site']}: '{info['title']}' {sorted(heights)}p, {len(info['formats'])} formats")
