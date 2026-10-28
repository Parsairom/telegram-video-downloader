"""Pure-logic unit tests (no network, no ffmpeg)."""
from __future__ import annotations

import pytest

from app.errors import MediaError, classify_error
from app.ffmpeg_service import StreamPlan, parse_probe, plan_streams
from app.formats import build_selector, container_compat, normalise_format
from app.metadata import human_duration, human_size, render_caption, safe_filename
from app.models import StartJobRequest
from app.source_registry import DirectMediaAdapter, SourceRegistry, YtDlpAdapter
from app.ytdlp_worker import describe, make_selector

# ───────────────────────── formats ─────────────────────────


def test_container_compat_rules():
    assert container_compat("avc1.64002a", "mp4a.40.2", "mp4") == (True, None)
    assert container_compat("vp9", "opus", "webm")[0]
    assert container_compat("vp9", "opus", "mp4")[0]  # copyable (plays in most players)
    assert not container_compat("avc1", "aac", "webm")[0]  # H.264 cannot go in WebM
    assert not container_compat("vp8", "vorbis", "mp4")[0]
    assert container_compat("anything", "whatever", "mkv")[0]
    assert container_compat("anything", "whatever", "original")[0]
    ok, reason = container_compat(None, "opus", "m4a")
    assert not ok and "opus" in (reason or "")
    assert container_compat(None, "mp4a.40.2", "m4a")[0]


def test_normalise_format_video_audio_and_skips():
    video = normalise_format(
        {"format_id": "299", "ext": "mp4", "vcodec": "avc1.64002A", "acodec": "none", "width": 1920, "height": 1080,
         "fps": 60, "tbr": 3248, "protocol": "https", "dynamic_range": "SDR"},
        duration=600,
    )
    assert video and video["kind"] == "video" and video["hasAudio"] is False
    assert video["filesize"] == int(3248 * 1000 / 8 * 600) and video["filesizeApprox"] is True
    audio = normalise_format(
        {"format_id": "140", "ext": "m4a", "vcodec": "none", "acodec": "mp4a.40.2", "abr": 129, "language": "en",
         "filesize": 1000, "audio_channels": 2},
        duration=10,
    )
    assert audio and audio["kind"] == "audio" and audio["filesize"] == 1000 and audio["filesizeApprox"] is False
    assert audio["audioLanguage"] == "en"
    progressive = normalise_format(
        {"format_id": "18", "ext": "mp4", "vcodec": "avc1", "acodec": "mp4a", "width": 640, "height": 360}, duration=None
    )
    assert progressive and progressive["hasAudio"] is True and progressive["filesize"] is None
    assert normalise_format({"format_id": "sb0", "ext": "mhtml", "vcodec": "none", "acodec": "none"}, 10) is None
    assert normalise_format({"format_id": "drm1", "ext": "mp4", "vcodec": "avc1", "height": 720, "has_drm": True}, 10) is None
    assert normalise_format({"ext": "mp4"}, 10) is None


def test_describe_marks_drm_only_sources():
    info = {"id": "x", "title": "T", "formats": [{"format_id": "1", "ext": "mp4", "vcodec": "avc1", "height": 720, "has_drm": True}]}
    result = describe(info, "https://example.com/x")
    assert result["formats"] == [] and result["drmProtected"] is True
    ok = describe({"id": "y", "title": "Y", "formats": [{"format_id": "1", "ext": "mp4", "vcodec": "avc1", "acodec": "aac", "height": 720}]}, "u")
    assert ok["drmProtected"] is False and len(ok["formats"]) == 1


def test_build_selector():
    assert build_selector("299", "140") == "299+140"
    assert build_selector("18", None) == "18"
    assert build_selector(None, "140") == "140"
    with pytest.raises(ValueError):
        build_selector(None, None)
    with pytest.raises(ValueError):
        build_selector("1/2", None)


def test_custom_selector_picks_exact_ids_and_never_substitutes():
    pytest.importorskip("yt_dlp")
    formats = [
        {"format_id": "139", "ext": "m4a", "protocol": "https"},
        {"format_id": "299", "ext": "mp4", "protocol": "https"},
    ]
    chosen = list(make_selector("299", "139")({"formats": formats}))
    assert len(chosen) == 1 and chosen[0]["format_id"] == "299+139"
    assert [f["format_id"] for f in chosen[0]["requested_formats"]] == ["299", "139"]
    single = list(make_selector("299", None)({"formats": formats}))
    assert single[0]["format_id"] == "299"
    with pytest.raises(Exception, match="Requested format is not available"):
        list(make_selector("404", None)({"formats": formats}))


# ───────────────────────── errors ─────────────────────────


@pytest.mark.parametrize(
    ("message", "code"),
    [
        ("ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies", "bot_check"),
        ("All player responses are invalid. Your IP is likely being blocked by Youtube", "bot_check"),
        ("ERROR: [generic] Unsupported URL: https://example.com/page", "unsupported_site"),
        ("ERROR: [youtube] abc: Private video. Sign in if you've been granted access", "private_video"),
        ("ERROR: Video unavailable. This video has been removed by the uploader", "unavailable"),
        ("The uploader has not made this video available in your country", "geo_restricted"),
        ("ERROR: Requested format is not available. Use --list-formats", "format_unavailable"),
        ("HTTP Error 429: Too Many Requests", "rate_limited"),
        ("ERROR: Unable to download webpage: HTTP Error 404: Not Found", "unavailable"),
        ("This video is protected by DRM (Widevine)", "drm_protected"),
        ("[Errno 28] No space left on device", "disk_full"),
        ("<urlopen error [Errno -2] Name or service not known>", "network_error"),
        ("Read timed out.", "network_error"),
        ("File is larger than max-filesize (2000 bytes > 1000 bytes)", "too_large"),
        ("something completely different", "internal"),
    ],
)
def test_classify_error(message, code):
    got, retryable = classify_error(message)
    assert got == code
    retryable_codes = {"network_error", "rate_limited", "upload_failed", "telegram_error", "timeout", "container_lost", "ffmpeg_failed", "disk_full"}
    assert retryable == (code in retryable_codes)  # same list as RETRYABLE_ERRORS in packages/shared-types


def test_media_error_retryable_default():
    assert MediaError("network_error", "x").retryable is True
    assert MediaError("private_video", "x").retryable is False
    assert MediaError("internal", "x", retryable=True).retryable is True


# ───────────────────────── metadata ─────────────────────────


@pytest.mark.parametrize(
    ("name", "ext", "expected"),
    [
        ("My Video", ".mp4", "My Video.mp4"),
        ("clip.mp4", ".mp4", "clip.mp4"),
        ("../../etc/passwd", ".mp4", "etc passwd.mp4"),
        ("a/b\\c:d*e?f\"g<h>i|j", ".mp4", "a b c d e f g h i j.mp4"),
        ("con", ".mp4", "_con.mp4"),
        ("   ...   ", ".mp4", "video.mp4"),
        ("-rf evil", ".mp4", "rf evil.mp4"),
        ("evil\x00name\n", ".mp4", "evil name.mp4"),
        ("x" * 500, ".mp4", "x" * 120 + ".mp4"),
        ("ok", ".exe", "ok.bin"),
        ("سلام دنیا", ".mkv", "سلام دنیا.mkv"),
        ("a\u202eb\u200bc", ".mp3", "abc.mp3"),
    ],
)
def test_safe_filename(name, ext, expected):
    assert safe_filename(name, ext) == expected


def test_render_caption_escapes_web_values_and_keeps_template_markup():
    out = render_caption("<b>{title}</b>\n{site} · {size}", {"title": "A <script>&", "site": "YouTube", "size": "5 MB"})
    assert out == "<b>A &lt;script&gt;&amp;</b>\nYouTube · 5 MB"


def test_render_caption_enforces_limit():
    out = render_caption("<b>{title}</b>\n" + "x" * 900 + "\n{title}", {"title": "T" * 2000})
    import html
    import re

    assert len(html.unescape(re.sub(r"<[^>]+>", "", out))) <= 1024
    huge = render_caption("y" * 5000, {})
    assert len(huge) <= 1024


def test_human_formatters():
    assert human_size(0) == "?" and human_size(1536) == "1.5 KB" and human_size(5 * 1024**3) == "5.0 GB"
    assert human_duration(65) == "1:05" and human_duration(3725) == "1:02:05" and human_duration(None) == "?"


# ───────────────────────── registry ─────────────────────────


def test_registry_picks_first_matching_adapter_and_falls_back():
    reg = SourceRegistry()
    assert isinstance(reg.select("https://example.com/watch?v=1"), YtDlpAdapter)
    reg.register(DirectMediaAdapter())
    assert reg.select("https://cdn.example.com/a/b/clip.MP4").name == "direct-media"
    assert reg.select("https://cdn.example.com/stream.m3u8?token=1").name == "direct-media"
    assert reg.select("https://example.com/page").name == "yt-dlp"

    class Custom(YtDlpAdapter):
        name = "custom-site"

        def matches(self, url: str) -> bool:
            return "custom.example" in url

    reg2 = SourceRegistry()
    reg2.register(Custom())
    assert reg2.select("https://custom.example/v/1").name == "custom-site"
    assert reg2.names == ["custom-site", "yt-dlp"]


# ───────────────────────── ffprobe parsing & stream planning ─────────────────────────

_PROBE_JSON = {
    "format": {"format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": "19.06", "size": "123456", "bit_rate": "5000",
               "tags": {"Title": "Hello"}},
    "streams": [
        {"index": 0, "codec_type": "video", "codec_name": "h264", "width": 1920, "height": 1080, "avg_frame_rate": "30000/1001",
         "pix_fmt": "yuv420p", "disposition": {"attached_pic": 0}},
        {"index": 1, "codec_type": "audio", "codec_name": "aac", "channels": 2, "sample_rate": "48000", "tags": {"language": "eng"}},
        {"index": 2, "codec_type": "video", "codec_name": "mjpeg", "width": 100, "height": 100, "disposition": {"attached_pic": 1}},
    ],
}


def test_parse_probe():
    pr = parse_probe("/x/y.mp4", _PROBE_JSON)
    assert pr.duration == 19.06 and pr.size == 123456 and pr.tags["title"] == "Hello"
    assert pr.video and pr.video.codec == "h264" and (pr.video.width, pr.video.height) == (1920, 1080)
    assert pr.video.fps == pytest.approx(29.97, abs=0.01)
    assert pr.audio and pr.audio.language == "eng"
    assert [s.attached_pic for s in pr.streams] == [False, False, True]  # cover art is not "the" video stream
    assert pr.to_dict()["video"]["codec"] == "h264"


def test_plan_streams_prefers_copy_and_refuses_silent_transcode():
    pr = parse_probe("x", _PROBE_JSON)
    assert plan_streams(pr, "mp4", False) == StreamPlan(video="copy", audio="copy")
    assert plan_streams(pr, "original", False).video == "copy"
    assert plan_streams(pr, "mkv", False).audio == "copy"
    with pytest.raises(MediaError) as exc:
        plan_streams(pr, "webm", False)  # H.264/AAC cannot be copied into WebM
    assert exc.value.code == "format_unavailable" and "Re-encoding" in exc.value.message
    plan = plan_streams(pr, "webm", True)
    assert plan.video == "encode" and plan.audio == "encode" and plan.notes


# ───────────────────────── request model ─────────────────────────


def test_start_job_request_validates_job_id_and_ignores_unknown_fields():
    base = {
        "jobId": "job_12345678", "url": "https://example.com/v.mp4", "chatId": 1, "extra": "ignored",
        "selection": {"kind": "video", "container": "mp4"}, "callback": {"baseUrl": "https://w.example", "token": "t"},
    }
    req = StartJobRequest.model_validate(base)
    assert req.selection.deliveryMode == "bot_api_cloud" and req.limits.maxOutputBytes == 1_900_000_000
    for bad in ("short", "has space 123", "../../etc/passwd", "x" * 100):
        with pytest.raises(ValueError):
            StartJobRequest.model_validate({**base, "jobId": bad})
    with pytest.raises(ValueError):
        StartJobRequest.model_validate({**base, "selection": {"kind": "video", "container": "exe"}})
