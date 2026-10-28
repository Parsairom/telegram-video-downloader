"""Regressions for defects that only showed up when the engine ran against the real network (SOCKS proxy, https sources)."""
from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from app import ffmpeg_service
from app.ffmpeg_service import REMOTE_PROTOCOLS


def test_httpx_can_use_a_socks_proxy():
    """TELEGRAM_PROXY is usually socks5h://…; httpx needs the `socksio` extra for that (ImportError otherwise)."""
    for proxy in ("socks5h://127.0.0.1:1080", "socks5://127.0.0.1:1080", "http://127.0.0.1:3128"):
        httpx.AsyncClient(proxy=proxy).aclose  # noqa: B018 - constructing the client is the test


def test_ffmpeg_whitelist_allows_the_https_proxy_tunnel():
    """Behind an HTTP proxy FFmpeg opens https:// through its internal `httpproxy` protocol; it must be whitelisted."""
    protocols = REMOTE_PROTOCOLS.split(",")
    assert {"http", "https", "httpproxy", "tcp", "tls", "crypto"} <= set(protocols)
    # nothing that could read local files or open arbitrary schemes
    assert not {"file", "ftp", "concat", "data", "subfile"} & set(protocols)


@pytest.mark.parametrize("which", ["probe", "frame"])
async def test_remote_ffmpeg_commands_use_that_whitelist(settings, monkeypatch, tmp_path: Path, which):
    seen: dict[str, list[str]] = {}

    async def fake_run(cmd, **_kwargs):
        seen["cmd"] = list(cmd)
        return 1, "", "stop here"  # the command line is what is under test

    monkeypatch.setattr(ffmpeg_service, "run_command", fake_run)
    if which == "probe":
        with pytest.raises(Exception, match="could not read"):
            await ffmpeg_service.probe_url(settings, "https://example.com/v.mp4")
    else:
        await ffmpeg_service.extract_frame(settings, "https://example.com/v.mp4", 1.0, tmp_path / "f.jpg", proxy="http://127.0.0.1:3128")
    cmd = seen["cmd"]
    whitelist = cmd[cmd.index("-protocol_whitelist") + 1]
    assert "httpproxy" in whitelist.split(",")
