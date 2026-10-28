"""MTProto sender, upstream proxy chaining and engine registration — all against local fakes (no Telegram needed)."""
from __future__ import annotations

import asyncio
import dataclasses
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from fastapi import FastAPI, Request
from telethon import errors

from app.errors import MediaError
from app.mtproto import MtprotoSender, telethon_proxy
from app.registrar import Registrar
from app.security import PolicyProxy, open_through_proxy


@pytest.fixture
def mt_settings(settings, tmp_path):
    return dataclasses.replace(settings, telegram_api_id="12345", telegram_api_hash="abc" * 10, bot_token="1:TOKEN", mtproto_session=tmp_path / "s")


# ───────────────────────── MTProto ─────────────────────────


class FakeTelethon:
    def __init__(self, fail_with: list[Exception] | None = None) -> None:
        self.sent: list[tuple[Any, str, dict[str, Any]]] = []
        self.fail_with = fail_with or []
        self.entity_known = True

    def is_connected(self) -> bool:
        return True

    async def get_input_entity(self, chat_id: int):
        if not self.entity_known:
            raise ValueError("Could not find the input entity")
        return SimpleNamespace(user_id=chat_id, access_hash=777)

    async def send_file(self, peer, path, **kwargs):
        if self.fail_with:
            raise self.fail_with.pop(0)
        if kwargs.get("progress_callback"):
            kwargs["progress_callback"](50, 100)
        self.sent.append((peer, path, kwargs))
        return SimpleNamespace(id=4711)


def common(path: Path, **over):
    args = dict(chat_id=99, path=path, kind="video", send_as="auto", container="mp4", caption="<b>t</b>", filename="v.mp4", thumb=None,
                reply_to=7, duration=12.5, width=1280, height=720, title="T", performer="P", upload_timeout=30, on_progress=None)
    return {**args, **over}


def test_proxy_tuple_parsing():
    assert telethon_proxy(None) is None
    assert telethon_proxy("socks5://127.0.0.1:1080") == ("socks5", "127.0.0.1", 1080, True, None, None)
    assert telethon_proxy("socks5h://u%40x:p%3Aw@h.example:9050") == ("socks5", "h.example", 9050, True, "u@x", "p:w")
    assert telethon_proxy("http://127.0.0.1:8080")[0] == "http"
    with pytest.raises(ValueError):
        telethon_proxy("ftp://x:1")


def test_availability_needs_credentials_and_token(settings, mt_settings):
    assert not MtprotoSender(settings).available  # no api id/hash in the test environment
    assert MtprotoSender(mt_settings).available
    assert not MtprotoSender(dataclasses.replace(mt_settings, bot_token=None)).available


async def test_video_is_sent_with_streaming_attributes_caption_thumb_and_reply(mt_settings, tmp_path):
    video = tmp_path / "v.mp4"
    video.write_bytes(b"x" * 1000)
    thumb = tmp_path / "t.jpg"
    thumb.write_bytes(b"j")
    sender = MtprotoSender(mt_settings)
    sender._client = fake = FakeTelethon()
    progress: list[tuple[int, int]] = []
    result = await sender.send(**common(video, thumb=thumb, on_progress=lambda a, b: progress.append((a, b))))
    peer, path, kw = fake.sent[0]
    assert peer.user_id == 99 and path == str(video)
    assert kw["caption"] == "<b>t</b>" and kw["parse_mode"] == "html" and kw["reply_to"] == 7 and kw["thumb"] == str(thumb)
    attr = kw["attributes"][0]
    assert (attr.w, attr.h, attr.duration, attr.supports_streaming) == (1280, 720, 12.5, True)
    assert kw["force_document"] is False
    assert progress == [(50, 100)]
    assert result["telegramMessageId"] == 4711 and result["sizeBytes"] == 1000 and result["method"] == "mtproto"


async def test_audio_and_document_variants(mt_settings, tmp_path):
    mp3 = tmp_path / "a.mp3"
    mp3.write_bytes(b"x" * 10)
    mkv = tmp_path / "v.mkv"
    mkv.write_bytes(b"x" * 10)
    sender = MtprotoSender(mt_settings)
    sender._client = fake = FakeTelethon()
    await sender.send(**common(mp3, kind="audio", container="mp3", filename="a.mp3"))
    audio_attr = fake.sent[0][2]["attributes"][0]
    assert (audio_attr.title, audio_attr.performer, audio_attr.duration) == ("T", "P", 12)
    await sender.send(**common(mkv, container="mkv", filename="v.mkv"))
    assert fake.sent[1][2]["force_document"] is True and fake.sent[1][2]["attributes"] is None  # mkv is not streamable video
    await sender.send(**common(mkv, send_as="document", container="mp4"))
    assert fake.sent[2][2]["force_document"] is True


async def test_unseen_user_falls_back_to_access_hash_zero(mt_settings, tmp_path):
    f = tmp_path / "v.mp4"
    f.write_bytes(b"x")
    sender = MtprotoSender(mt_settings)
    sender._client = fake = FakeTelethon()
    fake.entity_known = False
    await sender.send(**common(f))
    assert (fake.sent[0][0].user_id, fake.sent[0][0].access_hash) == (99, 0)


async def test_refuses_files_above_the_mtproto_limit_without_touching_telegram(mt_settings, tmp_path):
    f = tmp_path / "big.mp4"
    f.write_bytes(b"x" * 100)
    sender = MtprotoSender(dataclasses.replace(mt_settings, mtproto_upload_limit_bytes=50))
    sender._client = fake = FakeTelethon()
    with pytest.raises(MediaError) as exc:
        await sender.send(**common(f))
    assert exc.value.code == "too_large" and not exc.value.retryable and not fake.sent


async def test_flood_wait_is_retried_and_undeliverable_chats_are_not(mt_settings, tmp_path, monkeypatch):
    f = tmp_path / "v.mp4"
    f.write_bytes(b"x")
    sleeps: list[float] = []

    async def fake_sleep(s):
        sleeps.append(s)

    monkeypatch.setattr(asyncio, "sleep", fake_sleep)
    sender = MtprotoSender(mt_settings)
    sender._client = fake = FakeTelethon(fail_with=[errors.FloodWaitError(request=None, capture=3)])
    assert (await sender.send(**common(f)))["telegramMessageId"] == 4711
    assert sleeps == [4]  # waited the requested 3 s (+1)
    sender._client = FakeTelethon(fail_with=[errors.UserIsBlockedError(request=None)])
    with pytest.raises(MediaError) as exc:
        await sender.send(**common(f))
    assert exc.value.code == "telegram_error" and exc.value.retryable is False
    assert "message the bot" in exc.value.message
    sender._client = FakeTelethon(fail_with=[errors.FloodWaitError(request=None, capture=9999)])
    with pytest.raises(MediaError) as exc2:
        await sender.send(**common(f))
    assert exc2.value.code == "rate_limited" and exc2.value.retryable is True
    assert fake.sent  # (first client delivered once)


# ───────────────────────── upstream proxy chaining ─────────────────────────


async def fake_socks5(record: list[str], target_port: int):
    """Minimal SOCKS5 server: records the requested host:port and connects to `target_port` on localhost instead."""

    async def handle(reader, writer):
        await reader.readexactly(2 + (await reader.readexactly(1))[0]) if False else None
        header = await reader.readexactly(2)
        await reader.readexactly(header[1])
        writer.write(b"\x05\x00")
        req = await reader.readexactly(4)
        if req[3] == 3:
            n = (await reader.readexactly(1))[0]
            host = (await reader.readexactly(n)).decode()
        elif req[3] == 1:
            host = ".".join(str(b) for b in await reader.readexactly(4))
        else:
            host = (await reader.readexactly(16)).hex()
        port = int.from_bytes(await reader.readexactly(2), "big")
        record.append(f"{host}:{port}")
        up_r, up_w = await asyncio.open_connection("127.0.0.1", target_port)
        writer.write(b"\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00")
        await writer.drain()

        async def pump(src, dst):
            try:
                while data := await src.read(65536):
                    dst.write(data)
                    await dst.drain()
            except OSError:
                pass
            finally:
                dst.close()

        await asyncio.gather(pump(reader, up_w), pump(up_r, writer))

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    return server, server.sockets[0].getsockname()[1]


async def test_policy_proxy_chains_through_a_socks5_upstream(serve):
    app = FastAPI()

    @app.get("/hello")
    def hello():
        return {"via": "upstream"}

    with serve(app) as target:
        seen: list[str] = []
        server, socks_port = await fake_socks5(seen, target.port)
        proxy = PolicyProxy(port=0, upstream=f"socks5h://127.0.0.1:{socks_port}")
        port = await proxy.start()
        try:
            async with httpx.AsyncClient(proxy=f"http://127.0.0.1:{port}", timeout=10) as client:
                resp = await client.get("http://media.example.com:8080/hello")  # a public-looking host the upstream "resolves"
                assert resp.status_code == 200 and resp.json() == {"via": "upstream"}
                assert seen == ["media.example.com:8080"]  # the hostname went to the upstream proxy, not through local DNS
                # literal private addresses and internal names are still refused locally, before any upstream connection
                blocked = await client.get("http://127.0.0.1:9/x")
                assert blocked.status_code == 403
                blocked2 = await client.get("http://metadata.google.internal/")
                assert blocked2.status_code == 403
                assert seen == ["media.example.com:8080"]
        finally:
            await proxy.stop()
            server.close()


async def test_http_connect_upstream_and_failure_modes(serve):
    app = FastAPI()

    @app.get("/x")
    def x():
        return {"ok": True}

    with serve(app) as target:
        requests: list[str] = []

        async def handle(reader, writer):
            line = (await reader.readuntil(b"\r\n\r\n")).split(b"\r\n")[0].decode()
            requests.append(line)
            up_r, up_w = await asyncio.open_connection("127.0.0.1", target.port)
            writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
            await writer.drain()

            async def pump(src, dst):
                try:
                    while data := await src.read(65536):
                        dst.write(data)
                        await dst.drain()
                except OSError:
                    pass
                finally:
                    dst.close()

            await asyncio.gather(pump(reader, up_w), pump(up_r, writer))

        server = await asyncio.start_server(handle, "127.0.0.1", 0)
        http_port = server.sockets[0].getsockname()[1]
        try:
            reader, writer = await open_through_proxy(f"http://127.0.0.1:{http_port}", "files.example.org", 80)
            writer.write(b"GET /x HTTP/1.1\r\nHost: files.example.org\r\nConnection: close\r\n\r\n")
            await writer.drain()
            assert b"200 OK" in (await reader.read(4096))
            writer.close()
            assert requests == ["CONNECT files.example.org:80 HTTP/1.1"]
        finally:
            server.close()
    with pytest.raises(OSError):  # nothing listening
        await open_through_proxy("socks5h://127.0.0.1:1", "example.com", 80)
    with pytest.raises(ValueError):
        await open_through_proxy("gopher://127.0.0.1:70", "example.com", 80)


# ───────────────────────── engine registration ─────────────────────────


async def test_registrar_sends_authenticated_heartbeats_and_deregisters(settings, serve):
    received: list[dict[str, Any]] = []
    auth: list[str] = []
    worker = FastAPI()

    @worker.post("/internal/engine/register")
    async def register(request: Request):
        auth.append(request.headers.get("authorization", ""))
        received.append(await request.json())
        return {"ok": True}

    with serve(worker) as w:
        s = dataclasses.replace(settings, api_key="engine-key", worker_base_url=w.url, engine_public_url="https://abc.trycloudflare.com", engine_name="pc")
        reg = Registrar(s, lambda: {"activeJobs": 2})
        assert reg.enabled
        reg.start()
        for _ in range(100):
            if received:
                break
            await asyncio.sleep(0.05)
        await reg.stop()
    assert received[0]["url"] == "https://abc.trycloudflare.com" and received[0]["activeJobs"] == 2 and received[0]["name"] == "pc"
    assert received[0]["capabilities"] == {"mtproto": False, "localBotApi": False} and received[0]["ytdlp"]
    assert received[-1] == {"url": None}  # deregistration on shutdown
    assert set(auth) == {"Bearer engine-key"}


def test_registrar_is_disabled_without_the_three_settings(settings):
    assert not Registrar(settings, dict).enabled
    assert not Registrar(dataclasses.replace(settings, worker_base_url="https://w", engine_public_url=None, api_key="k"), dict).enabled
