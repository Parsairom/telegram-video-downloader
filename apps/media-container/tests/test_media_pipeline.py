"""FFmpeg/FFprobe integration tests. They run real binaries and are skipped when ffmpeg+ffprobe are missing
(reported as SKIPPED, never as passed)."""
from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path

import pytest
from PIL import Image

from app import ffmpeg_service as ff
from app.errors import MediaError
from app.thumbnails import (
    build_thumbnail,
    frame_is_usable,
    to_telegram_thumbnail,
    validate_thumbnail,
)

from .conftest import needs_ffmpeg

pytestmark = needs_ffmpeg


def make_clip(path: Path, *, seconds: float = 3, size: str = "640x360", vcodec: str = "libx264", acodec: str | None = "aac",
              extra: list[str] | None = None) -> Path:
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"testsrc2=size={size}:rate=25:duration={seconds}"]
    if acodec:
        cmd += ["-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}"]
    cmd += ["-c:v", vcodec, "-pix_fmt", "yuv420p"]
    if acodec:
        cmd += ["-c:a", acodec]
    cmd += (extra or []) + [str(path)]
    subprocess.run(cmd, check=True)
    return path


async def test_probe_reports_streams(settings, tmp_path):
    clip = make_clip(tmp_path / "a.mp4")
    pr = await ff.probe(settings, clip)
    assert pr.video and (pr.video.width, pr.video.height) == (640, 360) and pr.video.codec == "h264"
    assert pr.audio and pr.audio.codec == "aac"
    assert pr.duration == pytest.approx(3.0, abs=0.3)


async def test_probe_rejects_garbage(settings, tmp_path):
    bad = tmp_path / "bad.mp4"
    bad.write_bytes(b"this is not a video" * 100)
    with pytest.raises(MediaError) as exc:
        await ff.probe(settings, bad)
    assert exc.value.code == "validation_failed"


async def test_finalize_mp4_copies_streams_and_writes_metadata(settings, tmp_path):
    src = make_clip(tmp_path / "src.mkv", vcodec="libx264", acodec="aac")
    pr = await ff.probe(settings, src)
    plan = ff.plan_streams(pr, "mp4", False)
    assert (plan.video, plan.audio) == ("copy", "copy")
    dst = tmp_path / "out.mp4"
    await ff.finalize_video(settings, src, dst, container="mp4", plan=plan, pr=pr, title="عنوان تست", artist="Tester", timeout=60)
    report = await ff.validate_output(settings, dst, kind="video", container="mp4", max_bytes=10**9, expected_height_short_side=360)
    assert report.ok, report.errors
    assert report.probe and report.probe.tags.get("title") == "عنوان تست" and report.probe.tags.get("artist") == "Tester"
    assert report.probe.video.codec == "h264"  # copied, not re-encoded
    # faststart: the moov atom comes before mdat
    head = dst.read_bytes()[:4096]
    assert head.find(b"moov") != -1 and (head.find(b"mdat") == -1 or head.find(b"moov") < head.find(b"mdat"))


async def test_webm_from_h264_requires_explicit_transcode(settings, tmp_path):
    src = make_clip(tmp_path / "src.mp4", seconds=2)
    pr = await ff.probe(settings, src)
    with pytest.raises(MediaError) as exc:
        ff.plan_streams(pr, "webm", False)
    assert exc.value.code == "format_unavailable"
    plan = ff.plan_streams(pr, "webm", True)
    dst = tmp_path / "out.webm"
    await ff.finalize_video(settings, src, dst, container="webm", plan=plan, pr=pr, title=None, artist=None, timeout=240)
    report = await ff.validate_output(settings, dst, kind="video", container="webm", max_bytes=10**9)
    assert report.ok, report.errors
    assert report.probe.video.codec == "vp9" and report.probe.audio.codec == "opus"


async def test_opus_audio_is_encoded_to_aac_only_when_needed(settings, tmp_path):
    src = make_clip(tmp_path / "src.mkv", seconds=2, acodec="libopus")
    pr = await ff.probe(settings, src)
    assert pr.audio.codec == "opus"
    dst = tmp_path / "audio.m4a"
    await ff.finalize_audio(settings, src, dst, container="m4a", pr=pr, title="T", artist="A", timeout=60)
    out = await ff.probe(settings, dst)
    assert out.audio.codec == "aac" and out.video is None
    mp3 = tmp_path / "audio.mp3"
    await ff.finalize_audio(settings, src, mp3, container="mp3", pr=pr, title="T", artist="A", timeout=60)
    assert (await ff.probe(settings, mp3)).audio.codec == "mp3"


async def test_validate_output_catches_bad_files(settings, tmp_path):
    missing = await ff.validate_output(settings, tmp_path / "nope.mp4", kind="video", container="mp4", max_bytes=10**9)
    assert not missing.ok and "does not exist" in missing.errors[0]
    empty = tmp_path / "empty.mp4"
    empty.write_bytes(b"")
    assert not (await ff.validate_output(settings, empty, kind="video", container="mp4", max_bytes=10**9)).ok
    junk = tmp_path / "junk.mp4"
    junk.write_bytes(b"junk" * 1000)
    assert not (await ff.validate_output(settings, junk, kind="video", container="mp4", max_bytes=10**9)).ok
    good = make_clip(tmp_path / "good.mp4")
    too_big = await ff.validate_output(settings, good, kind="video", container="mp4", max_bytes=1000)
    assert not too_big.ok and any("limit" in e for e in too_big.errors)
    wrong = await ff.validate_output(settings, good, kind="video", container="webm", max_bytes=10**9)
    assert not wrong.ok and any("expected webm" in e for e in wrong.errors)
    audio_only = make_clip(tmp_path / "silent.mp4", acodec=None)
    r = await ff.validate_output(settings, audio_only, kind="video", container="mp4", max_bytes=10**9)
    assert r.ok and any("no audio" in w for w in r.warnings)  # silent source = warning, not failure
    low = await ff.validate_output(settings, good, kind="video", container="mp4", max_bytes=10**9, expected_height_short_side=1080)
    assert not low.ok and any("far below" in e for e in low.errors)  # 360p output can never pass as 1080p


async def test_truncated_file_fails_validation_or_duration_check(settings, tmp_path):
    good = make_clip(tmp_path / "g.mp4", seconds=4)
    cut = tmp_path / "cut.mp4"
    cut.write_bytes(good.read_bytes()[: good.stat().st_size // 3])
    report = await ff.validate_output(settings, cut, kind="video", container="mp4", max_bytes=10**9, source_duration=4)
    assert not report.ok  # missing moov atom -> ffprobe cannot read it


async def test_telegram_thumbnail_rules(settings, tmp_path):
    clip = make_clip(tmp_path / "t.mp4", size="1280x720")
    raw = tmp_path / "frame.jpg"
    assert await ff.extract_frame(settings, str(clip), 1.0, raw)
    assert frame_is_usable(raw)
    thumb = await to_telegram_thumbnail(raw, tmp_path / "thumb.jpg")
    assert thumb is not None
    ok, why = validate_thumbnail(thumb)
    assert ok, why
    with Image.open(thumb) as img:
        assert img.format == "JPEG" and max(img.size) <= 320 and abs(img.width / img.height - 16 / 9) < 0.05
    assert thumb.stat().st_size < 200 * 1024
    # a PNG renamed to .jpg is not a valid Telegram thumbnail
    fake = tmp_path / "fake.jpg"
    Image.new("RGB", (100, 100), "red").save(fake, "PNG")
    assert not validate_thumbnail(fake)[0]
    big = tmp_path / "big.jpg"
    Image.new("RGB", (640, 480), "red").save(big, "JPEG")
    assert not validate_thumbnail(big)[0]


async def test_black_frames_are_rejected(settings, tmp_path):
    black = tmp_path / "black.jpg"
    Image.new("RGB", (320, 180), "black").save(black, "JPEG")
    assert not frame_is_usable(black)


async def test_build_thumbnail_modes(settings, tmp_path):
    clip = make_clip(tmp_path / "v.mp4", size="1280x720", seconds=4)
    work = tmp_path / "work"
    work.mkdir()
    common = dict(video=clip, workdir=work, cover_url=None, custom_file_id=None, frame_timestamp=None,
                  duration=4.0, width=1280, height=720)
    assert await build_thumbnail(settings, mode="none", **common) is None
    frame = await build_thumbnail(settings, mode="frame", **{**common, "frame_timestamp": 2.0})
    assert frame and validate_thumbnail(frame)[0]
    # original requested but no cover URL available -> falls back to a frame instead of failing
    fallback = await build_thumbnail(settings, mode="original", **common)
    assert fallback and validate_thumbnail(fallback)[0]


async def test_cancel_kills_ffmpeg(settings, tmp_path):
    from app.errors import JobCancelled

    src = make_clip(tmp_path / "long.mp4", seconds=20, size="1280x720")
    pr = await ff.probe(settings, src)
    plan = ff.StreamPlan(video="encode", audio="encode")  # force a slow re-encode so there is something to cancel
    cancel = asyncio.Event()
    asyncio.get_running_loop().call_later(0.5, cancel.set)
    with pytest.raises(JobCancelled):
        await ff.finalize_video(settings, src, tmp_path / "o.mp4", container="mp4", plan=plan, pr=pr, title=None,
                                artist=None, timeout=120, cancel=cancel)
