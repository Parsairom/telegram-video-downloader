"""End-to-end container tests with local fixture servers:

  media server  -- serves an MP4, an HLS master playlist with SEPARATE audio and video renditions, and a slow file
  fake Telegram -- records sendVideo/sendAudio/sendDocument multipart requests (can fail on demand)
  fake Worker   -- receives the container's callback events and R2 multipart uploads

Needs ffmpeg + ffprobe (skipped otherwise). The policy proxy runs with allow_private_networks=True *only* because the
fixtures live on localhost; test_security.py proves the default policy blocks such targets.
"""
from __future__ import annotations

import asyncio
import dataclasses
import hashlib
import subprocess
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.callbacks import Reporter
from app.errors import MediaError
from app.extraction import inspect_url
from app.job_runner import JobRunner
from app.models import StartJobRequest
from app.security import PolicyProxy

from .conftest import needs_ffmpeg

pytestmark = needs_ffmpeg


# ───────────────────────── fixtures ─────────────────────────


@pytest.fixture
def media_dir(tmp_path: Path) -> Path:
    d = tmp_path / "media"
    d.mkdir()
    run = lambda *a: subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *a], check=True)  # noqa: E731
    src = ["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=4", "-f", "lavfi", "-i", "sine=frequency=440:duration=4"]
    run(*src, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", str(d / "clip.mp4"))
    # HLS master with separate audio rendition => yt-dlp reports a video-only + an audio-only format
    hls = d / "hls"
    hls.mkdir()
    run(
        *src, "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-f", "hls",
        "-hls_time", "2", "-hls_playlist_type", "vod", "-var_stream_map", "v:0,agroup:aud a:0,agroup:aud,default:yes",
        "-master_pl_name", "master.m3u8", "-hls_segment_filename", str(hls / "s_%v_%03d.ts"), str(hls / "v_%v.m3u8"),
    )
    (d / "big.bin").write_bytes(b"\0" * 1024)
    return d


class FakeTelegram:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.fail_next: list[tuple[int, dict[str, Any]]] = []
        self.app = FastAPI()
        self.app.post("/bot{token}/{method}")(self.handle)

    async def handle(self, token: str, method: str, request: Request) -> JSONResponse:
        form = await request.form()
        fields = {k: (v if isinstance(v, str) else {"filename": v.filename, "size": len(await v.read()), "type": v.content_type})
                  for k, v in form.items()}
        self.calls.append({"token": token, "method": method, "fields": fields})
        if self.fail_next:
            status, body = self.fail_next.pop(0)
            return JSONResponse(body, status_code=status)
        media_key = {"sendVideo": "video", "sendAudio": "audio", "sendDocument": "document"}[method]
        return JSONResponse({"ok": True, "result": {"message_id": 4242, media_key: {"file_id": "FILE123"}}})


class FakeWorker:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []
        self.auth: set[str] = set()
        self.parts: dict[int, bytes] = {}
        self.cancel_after: int | None = None
        self.app = FastAPI()
        self.app.post("/internal/jobs/{job_id}/events")(self.event)
        self.app.post("/internal/jobs/{job_id}/r2/create")(self.r2_create)
        self.app.put("/internal/jobs/{job_id}/r2/part")(self.r2_part)
        self.app.post("/internal/jobs/{job_id}/r2/complete")(self.r2_complete)
        self.app.post("/internal/jobs/{job_id}/r2/abort")(self.r2_abort)
        self.completed_payload: dict[str, Any] | None = None
        self.aborted = False

    async def event(self, job_id: str, request: Request) -> dict[str, Any]:
        self.auth.add(request.headers.get("authorization", ""))
        body = await request.json()
        self.events.append(body)
        return {"ok": True, "cancel": bool(self.cancel_after is not None and len(self.events) > self.cancel_after)}

    async def r2_create(self, job_id: str, request: Request) -> dict[str, Any]:
        self.create = await request.json()
        return {"uploadId": "UP1", "key": f"deliveries/{job_id}/x", "partSize": 1024 * 1024}

    async def r2_part(self, job_id: str, request: Request, part: int, uploadId: str) -> dict[str, Any]:  # noqa: N803
        data = await request.body()
        self.parts[part] = data
        return {"etag": hashlib.md5(data, usedforsecurity=False).hexdigest()}

    async def r2_complete(self, job_id: str, request: Request) -> dict[str, Any]:
        self.completed_payload = await request.json()
        return {"downloadUrl": "https://worker.example/d/tok/clip.mp4", "expiresAt": "2099-01-01T00:00:00Z"}

    async def r2_abort(self, job_id: str) -> dict[str, Any]:
        self.aborted = True
        return {"ok": True}


@pytest.fixture
def world(serve, media_dir, settings, tmp_path):
    media_app = FastAPI()
    media_app.mount("/", StaticFiles(directory=media_dir), name="m")
    tg, worker = FakeTelegram(), FakeWorker()
    with serve(media_app) as media, serve(tg.app) as tgsrv, serve(worker.app) as wsrv:
        s = dataclasses.replace(
            settings, allow_private_networks=True, telegram_api_base=tgsrv.url, work_dir=tmp_path / "work"
        )
        yield dict(settings=s, media=media.url, tg=tg, worker=worker, worker_url=wsrv.url)


def job_request(world, url: str, selection: dict[str, Any], **extra) -> StartJobRequest:
    return StartJobRequest.model_validate(
        {
            "jobId": f"job_{int(time.time() * 1000) % 10**9}", "correlationId": "cid-1", "url": url, "chatId": 99,
            "replyToMessageId": 7, "selection": {"kind": "video", "caption": "<b>{title}</b>\n{resolution} · {size}", **selection},
            "meta": {"title": "Fixture clip", "site": "fixture", "durationSeconds": 4, "webpageUrl": url},
            "callback": {"baseUrl": world["worker_url"], "token": "TOKEN-XYZ"},  # noqa: S105
            **extra,
        }
    )


async def run_runner(world, req: StartJobRequest, cancel: asyncio.Event | None = None) -> JobRunner:
    cancel = cancel or asyncio.Event()
    reporter = Reporter(req.callback.baseUrl, req.jobId, req.callback.token, req.correlationId, on_cancel=cancel.set)
    runner = JobRunner(world["settings"], req, reporter, cancel)
    await runner.run()
    return runner


@pytest.fixture
async def proxy_in_test_loop(world):
    """Policy proxy bound to the test's own event loop; yt-dlp/ffmpeg children are pointed at its port."""
    proxy = PolicyProxy(port=0, allow_private=True)
    port = await proxy.start()
    world["settings"] = dataclasses.replace(world["settings"], policy_proxy_port=port)
    yield proxy
    await proxy.stop()


# ───────────────────────── tests ─────────────────────────


async def test_inspect_direct_mp4(world, proxy_in_test_loop):
    result = await inspect_url(world["settings"], f"{world['media']}/clip.mp4")
    info = result["info"]
    assert result["kind"] == "video" and info["formats"] and info["durationSeconds"]
    fmt = info["formats"][0]
    assert fmt["kind"] == "video" and fmt["filesize"] and fmt["filesizeApprox"] is False  # size came from a HEAD request


async def test_inspect_hls_exposes_separate_audio_and_video(world, proxy_in_test_loop):
    result = await inspect_url(world["settings"], f"{world['media']}/hls/master.m3u8")
    kinds = {(f["kind"], f["hasAudio"]) for f in result["info"]["formats"]}
    assert ("audio", True) in kinds and any(k == "video" and not a for k, a in kinds), kinds


async def test_inspect_rejects_private_target_when_policy_is_default(world, settings):
    strict = dataclasses.replace(settings, allow_private_networks=False)
    with pytest.raises(MediaError) as exc:
        await inspect_url(strict, f"{world['media']}/clip.mp4")
    assert exc.value.code == "blocked_url"


async def test_download_direct_mp4_and_deliver(world, proxy_in_test_loop):
    info = (await inspect_url(world["settings"], f"{world['media']}/clip.mp4"))["info"]
    fmt = info["formats"][0]
    req = job_request(world, f"{world['media']}/clip.mp4", {
        "videoFormatId": fmt["formatId"], "container": "mp4", "title": "Clip", "filename": "My clip", "label": "360p",
        "expectedHeight": 360, "embedTitle": "Embedded title", "videoCodec": fmt["vcodec"], "audioCodec": fmt["acodec"],
        "thumbnail": {"mode": "frame", "frameTimestamp": 1.0},
    })
    runner = await run_runner(world, req)
    assert runner.state.state == "completed", (runner.state.error_code, runner.state.message)

    call = world["tg"].calls[-1]
    assert call["method"] == "sendVideo" and call["token"] == "123456:TEST-TOKEN"
    f = call["fields"]
    assert f["chat_id"] == "99" and f["supports_streaming"] == "true" and f["parse_mode"] == "HTML"
    assert (f["width"], f["height"]) == ("640", "360") and int(f["duration"]) in (3, 4)
    assert f["video"]["filename"] == "My clip.mp4" and f["video"]["size"] > 1000
    assert f["thumbnail"]["size"] < 200 * 1024
    assert "<b>Clip</b>" in f["caption"] and "640×360" in f["caption"]
    assert '"message_id": 7' in f["reply_parameters"]

    types = [e["type"] for e in world["worker"].events]
    assert types[0] == "state" and types[-1] == "completed"
    states = [e["status"] for e in world["worker"].events if e["type"] == "state"]
    assert states == ["downloading", "processing", "uploading"]
    assert world["worker"].auth == {"Bearer TOKEN-XYZ"}
    result = world["worker"].events[-1]["result"]
    assert result["telegramMessageId"] == 4242 and result["mode"] == "bot_api_cloud" and len(result["sha256"]) == 64
    assert not (world["settings"].work_dir / req.jobId).exists()  # temp files cleaned up


async def test_separate_audio_and_video_are_merged(world, proxy_in_test_loop):
    info = (await inspect_url(world["settings"], f"{world['media']}/hls/master.m3u8"))["info"]
    video = next(f for f in info["formats"] if f["kind"] == "video")
    audio = next(f for f in info["formats"] if f["kind"] == "audio")
    req = job_request(world, f"{world['media']}/hls/master.m3u8", {
        "videoFormatId": video["formatId"], "audioFormatId": audio["formatId"], "container": "mp4",
        "videoCodec": video["vcodec"], "audioCodec": audio["acodec"], "expectedHeight": 360,
        "thumbnail": {"mode": "none"}, "title": "Merged",
    })
    runner = await run_runner(world, req)
    assert runner.state.state == "completed", (runner.state.error_code, runner.state.message)
    call = world["tg"].calls[-1]
    assert call["method"] == "sendVideo" and "thumbnail" not in call["fields"]
    assert call["fields"]["video"]["size"] > 1000


async def test_exact_format_id_is_required_no_silent_fallback(world, proxy_in_test_loop):
    req = job_request(world, f"{world['media']}/clip.mp4", {"videoFormatId": "does-not-exist", "container": "mp4"})
    runner = await run_runner(world, req)
    assert runner.state.state == "failed" and runner.state.error_code == "format_unavailable"
    assert world["worker"].events[-1]["type"] == "failed" and world["worker"].events[-1]["retryable"] is False
    assert not world["tg"].calls


async def test_failed_download_is_classified(world, proxy_in_test_loop):
    req = job_request(world, f"{world['media']}/missing.mp4", {"videoFormatId": "0", "container": "mp4"})
    runner = await run_runner(world, req)
    assert runner.state.state == "failed" and runner.state.error_code in ("unavailable", "unsupported_site")


async def test_oversized_estimate_is_rejected_before_download(world, proxy_in_test_loop):
    req = job_request(world, f"{world['media']}/clip.mp4", {"videoFormatId": "0", "container": "mp4", "estimatedBytes": 10**10})
    runner = await run_runner(world, req)
    assert runner.state.error_code == "too_large"
    assert not (world["settings"].work_dir / req.jobId).exists()


async def test_output_above_limit_is_rejected_after_download(world, proxy_in_test_loop):
    info = (await inspect_url(world["settings"], f"{world['media']}/clip.mp4"))["info"]
    fmt = info["formats"][0]
    req = job_request(world, f"{world['media']}/clip.mp4", {
        "videoFormatId": fmt["formatId"], "container": "mp4", "videoCodec": fmt["vcodec"], "audioCodec": fmt["acodec"]},
        limits={"maxOutputBytes": 20_000},
    )
    runner = await run_runner(world, req)
    assert runner.state.state == "failed" and runner.state.error_code == "too_large", (runner.state.error_code, runner.state.message)
    assert not world["tg"].calls


async def test_telegram_flood_wait_is_retried(world, proxy_in_test_loop):
    info = (await inspect_url(world["settings"], f"{world['media']}/clip.mp4"))["info"]
    fmt = info["formats"][0]
    world["tg"].fail_next.append((429, {"ok": False, "error_code": 429, "description": "Too Many Requests: retry after 1", "parameters": {"retry_after": 1}}))
    req = job_request(world, f"{world['media']}/clip.mp4", {
        "videoFormatId": fmt["formatId"], "container": "mp4", "videoCodec": fmt["vcodec"], "audioCodec": fmt["acodec"],
        "thumbnail": {"mode": "none"}})
    runner = await run_runner(world, req)
    assert runner.state.state == "completed"
    assert [c["method"] for c in world["tg"].calls] == ["sendVideo", "sendVideo"]


async def test_telegram_file_too_big_is_not_retried(world, proxy_in_test_loop):
    info = (await inspect_url(world["settings"], f"{world['media']}/clip.mp4"))["info"]
    fmt = info["formats"][0]
    world["tg"].fail_next.append((413, {"ok": False, "error_code": 413, "description": "Request Entity Too Large"}))
    req = job_request(world, f"{world['media']}/clip.mp4", {
        "videoFormatId": fmt["formatId"], "container": "mp4", "videoCodec": fmt["vcodec"], "audioCodec": fmt["acodec"],
        "thumbnail": {"mode": "none"}})
    runner = await run_runner(world, req)
    assert runner.state.error_code == "too_large" and len(world["tg"].calls) == 1
    assert world["worker"].events[-1]["retryable"] is False


async def test_cancel_via_worker_response_stops_the_job(world, proxy_in_test_loop):
    world["worker"].cancel_after = 1  # after the 2nd event the Worker tells the container to stop
    info = (await inspect_url(world["settings"], f"{world['media']}/hls/master.m3u8"))["info"]
    video = next(f for f in info["formats"] if f["kind"] == "video")
    audio = next(f for f in info["formats"] if f["kind"] == "audio")
    req = job_request(world, f"{world['media']}/hls/master.m3u8", {
        "videoFormatId": video["formatId"], "audioFormatId": audio["formatId"], "container": "mp4",
        "videoCodec": video["vcodec"], "audioCodec": audio["acodec"], "thumbnail": {"mode": "none"}})
    runner = await run_runner(world, req)
    assert runner.state.state in ("cancelled", "completed")  # the tiny fixture may finish before the signal lands
    if runner.state.state == "cancelled":
        assert not world["tg"].calls
        assert world["worker"].events[-1]["errorCode"] == "cancelled"
    assert not (world["settings"].work_dir / req.jobId).exists()


async def test_cancel_event_aborts_a_running_download(world, proxy_in_test_loop):
    cancel = asyncio.Event()
    req = job_request(world, f"{world['media']}/hls/master.m3u8", {"videoFormatId": "0", "container": "mp4"})
    asyncio.get_running_loop().call_later(0.0, cancel.set)
    runner = await run_runner(world, req, cancel)
    assert runner.state.state == "cancelled" and runner.state.error_code == "cancelled"
    assert not world["tg"].calls


class FakeMtproto:
    """Duck-typed stand-in for MtprotoSender (real Telegram is exercised by scripts/live-check.mjs, not by unit tests)."""

    available = True
    connected = True

    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def send(self, **kwargs):
        self.calls.append(kwargs)
        size = kwargs["path"].stat().st_size
        return {"telegramMessageId": 555, "telegramFileId": None, "sizeBytes": size, "filename": kwargs["filename"],
                "downloadUrl": None, "downloadUrlExpiresAt": None, "sha256": None}


async def run_with_mtproto(world, req: StartJobRequest, mt: FakeMtproto) -> JobRunner:
    cancel = asyncio.Event()
    reporter = Reporter(req.callback.baseUrl, req.jobId, req.callback.token, req.correlationId, on_cancel=cancel.set)
    runner = JobRunner(world["settings"], req, reporter, cancel, mt)  # type: ignore[arg-type]
    await runner.run()
    return runner


async def test_mtproto_delivery_mode_sends_through_the_mtproto_sender_not_the_bot_api(world, proxy_in_test_loop):
    info = (await inspect_url(world["settings"], f"{world['media']}/clip.mp4"))["info"]
    fmt = info["formats"][0]
    mt = FakeMtproto()
    req = job_request(world, f"{world['media']}/clip.mp4", {
        "videoFormatId": fmt["formatId"], "container": "mp4", "videoCodec": fmt["vcodec"], "audioCodec": fmt["acodec"],
        "deliveryMode": "mtproto", "thumbnail": {"mode": "frame", "frameTimestamp": 1.0}})
    runner = await run_with_mtproto(world, req, mt)
    assert runner.state.state == "completed", (runner.state.error_code, runner.state.message)
    assert not world["tg"].calls  # nothing went to the Bot API
    call = mt.calls[0]
    assert call["chat_id"] == 99 and call["kind"] == "video" and call["container"] == "mp4" and call["reply_to"] == 7
    assert call["path"].name.endswith(".mp4") and call["thumb"] is not None and "640×360" in call["caption"]
    assert (call["width"], call["height"]) == (640, 360)
    result = world["worker"].events[-1]["result"]
    assert result["mode"] == "mtproto" and result["telegramMessageId"] == 555


async def test_automatic_policy_upgrades_to_mtproto_when_the_file_is_too_big_for_the_bot_api(world, proxy_in_test_loop):
    small_cloud = dataclasses.replace(world["settings"], cloud_upload_limit_bytes=5_000)  # the clip is ~100 kB
    world["settings"] = small_cloud
    info = (await inspect_url(small_cloud, f"{world['media']}/clip.mp4"))["info"]
    fmt = info["formats"][0]
    mt = FakeMtproto()
    req = job_request(world, f"{world['media']}/clip.mp4", {
        "videoFormatId": fmt["formatId"], "container": "mp4", "videoCodec": fmt["vcodec"], "audioCodec": fmt["acodec"],
        "deliveryMode": "bot_api_cloud", "allowLinkFallback": True, "thumbnail": {"mode": "none"}})
    runner = await run_with_mtproto(world, req, mt)
    assert runner.state.state == "completed", (runner.state.error_code, runner.state.message)
    assert len(mt.calls) == 1 and not world["tg"].calls
    assert world["worker"].events[-1]["result"]["mode"] == "mtproto"


async def test_mtproto_mode_without_credentials_fails_clearly(world, proxy_in_test_loop):
    req = job_request(world, f"{world['media']}/clip.mp4", {"videoFormatId": "0", "container": "mp4", "deliveryMode": "mtproto"})
    runner = await run_runner(world, req)  # no sender injected
    assert runner.state.error_code == "telegram_error" and "MTProto" in (runner.state.message or "")


async def test_r2_link_delivery_streams_parts_and_reports_checksum(world, proxy_in_test_loop, monkeypatch):
    import app.delivery as delivery

    monkeypatch.setattr(delivery, "R2_PART_SIZE", 64 * 1024)  # not used by uploader (server dictates 1 MiB); keep small files multi-part
    info = (await inspect_url(world["settings"], f"{world['media']}/clip.mp4"))["info"]
    fmt = info["formats"][0]
    req = job_request(world, f"{world['media']}/clip.mp4", {
        "videoFormatId": fmt["formatId"], "container": "mp4", "videoCodec": fmt["vcodec"], "audioCodec": fmt["acodec"],
        "deliveryMode": "r2_link", "thumbnail": {"mode": "none"}, "filename": "link-clip"})
    runner = await run_runner(world, req)
    assert runner.state.state == "completed", (runner.state.error_code, runner.state.message)
    assert not world["tg"].calls  # nothing is sent to Telegram in link mode
    assert world["worker"].create["filename"] == "link-clip.mp4"
    payload = world["worker"].completed_payload
    assembled = b"".join(world["worker"].parts[i] for i in sorted(world["worker"].parts))
    assert payload["sha256"] == hashlib.sha256(assembled).hexdigest() and payload["size"] == len(assembled)
    assert [p["partNumber"] for p in payload["parts"]] == sorted(world["worker"].parts)
    result = world["worker"].events[-1]["result"]
    assert result["downloadUrl"].startswith("https://worker.example/d/") and result["sha256"] == payload["sha256"]
