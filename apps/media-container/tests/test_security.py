from __future__ import annotations

import asyncio
import dataclasses

import httpx
import pytest
from fastapi import FastAPI

from app.security import PolicyProxy, UnsafeUrlError, is_public_ip, resolve_public, safe_env, validate_url


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com/video.mp4",
        "http://example.com:8080/a?b=c",
        "https://sub.domain.example.org/watch?v=abc",
        "https://8.8.8.8/x.mp4",
        "https://[2001:4860:4860::8888]/x",
    ],
)
def test_validate_url_accepts_public(url):
    assert validate_url(url) == url


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "data:text/plain;base64,AAAA",
        "gopher://example.com/",
        "ftp://example.com/x",
        "javascript:alert(1)",
        "http://localhost/x",
        "http://LOCALHOST./x",
        "http://foo.localhost/x",
        "http://127.0.0.1/x",
        "http://127.1/x",
        "http://2130706433/x",
        "http://0x7f000001/x",
        "http://0177.0.0.1/x",
        "http://10.0.0.5/x",
        "http://172.16.0.1/x",
        "http://192.168.1.1/x",
        "http://169.254.169.254/latest/meta-data/",
        "http://metadata.google.internal/computeMetadata/v1/",
        "http://100.64.0.1/x",
        "http://[::1]/x",
        "http://[::ffff:127.0.0.1]/x",
        "http://[::ffff:7f00:1]/x",
        "http://[fe80::1]/x",
        "http://[fd00::1]/x",
        "http://[64:ff9b::7f00:1]/x",
        "http://intranet/x",
        "http://printer.local/x",
        "http://user:pass@example.com/x",
        "http://example.com:22/x",
        "http://example.com:6379/x",
        "http://exa mple.com/x",
        "",
        "not a url",
        "http://" + "a" * 3000 + ".com",
    ],
)
def test_validate_url_rejects_internal_or_malformed(url):
    with pytest.raises(UnsafeUrlError):
        validate_url(url)


def test_is_public_ip():
    assert is_public_ip("8.8.8.8")
    assert is_public_ip("2606:4700:4700::1111")
    for bad in ("127.0.0.1", "10.1.2.3", "192.168.0.1", "169.254.169.254", "0.0.0.0", "224.0.0.1", "::1", "fe80::1", "::ffff:10.0.0.1", "100::1"):  # noqa: S104
        assert not is_public_ip(bad), bad
    assert not is_public_ip("not-an-ip")
    assert is_public_ip("127.0.0.1", allow_private=True)


def test_safe_env_has_no_secrets(monkeypatch):
    monkeypatch.setenv("BOT_TOKEN", "123:SECRET")
    monkeypatch.setenv("CONTAINER_API_KEY", "key")
    env = safe_env("http://127.0.0.1:3128")
    assert "BOT_TOKEN" not in env and "CONTAINER_API_KEY" not in env
    assert env["HTTPS_PROXY"] == "http://127.0.0.1:3128"
    assert not any("SECRET" in v for v in env.values())


async def test_resolve_public_blocks_loopback_hostname():
    with pytest.raises(UnsafeUrlError):
        await resolve_public("localhost", 80)


async def test_policy_proxy_blocks_private_targets(serve):
    # a fixture web server on localhost (a "private" target)
    app = FastAPI()

    @app.get("/secret")
    def secret():
        return {"leak": True}

    with serve(app) as target:
        proxy = PolicyProxy(port=0, allow_private=False)
        proxy_port = await proxy.start()
        try:
            async with httpx.AsyncClient(proxy=f"http://127.0.0.1:{proxy_port}", timeout=10) as client:
                resp = await client.get(f"{target.url}/secret")  # plain HTTP through the proxy
                assert resp.status_code == 403
                assert "leak" not in resp.text
                with pytest.raises(httpx.HTTPError):  # CONNECT tunnel to a private address
                    await client.get(f"https://127.0.0.1:{target.port}/secret")
            assert proxy.stats.blocked >= 2
            assert proxy.stats.allowed == 0
        finally:
            await proxy.stop()


async def test_policy_proxy_forwards_when_private_allowed(serve):
    app = FastAPI()

    @app.get("/ok")
    def ok():
        return {"ok": True}

    with serve(app) as target:
        proxy = PolicyProxy(port=0, allow_private=True)  # tests only
        proxy_port = await proxy.start()
        try:
            async with httpx.AsyncClient(proxy=f"http://127.0.0.1:{proxy_port}", timeout=10) as client:
                resp = await client.get(f"{target.url}/ok")
            assert resp.status_code == 200 and resp.json() == {"ok": True}
            assert proxy.stats.allowed == 1
        finally:
            await proxy.stop()


async def test_public_hostname_resolving_to_loopback_is_refused_at_connect_time():
    """DNS-rebinding style: a *public-looking* name whose A record is 127.0.0.1 passes URL validation but must be
    refused when the proxy resolves it (validation alone is not enough)."""
    import socket

    host = "localtest.me"  # public DNS name that resolves to 127.0.0.1
    try:
        addrs = {i[4][0] for i in await asyncio.get_running_loop().getaddrinfo(host, 80, type=socket.SOCK_STREAM)}
    except OSError:
        pytest.skip("DNS unavailable in this environment")
    if not addrs & {"127.0.0.1", "::1"}:
        pytest.skip("local DNS does not map localtest.me to loopback")
    assert validate_url(f"http://{host}/") == f"http://{host}/"  # looks public to the URL validator
    with pytest.raises(UnsafeUrlError):
        await resolve_public(host, 80)  # exactly what PolicyProxy._open() calls before connecting
    assert dataclasses.is_dataclass(PolicyProxy(port=0).stats)
