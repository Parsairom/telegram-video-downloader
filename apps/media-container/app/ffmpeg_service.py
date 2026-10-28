"""FFmpeg / FFprobe operations. Every command is an argument list — user text is never shell-interpolated."""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import signal
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .config import Settings
from .errors import JobCancelled, MediaError
from .formats import container_compat
from .security import safe_env

log = logging.getLogger("tvd.ffmpeg")


# ───────────────────────────────── process runner ─────────────────────────────────


def _kill(proc: asyncio.subprocess.Process) -> None:
    if proc.returncode is not None:
        return
    with contextlib.suppress(ProcessLookupError, PermissionError):
        if os.name == "nt":
            proc.kill()
        else:
            os.killpg(proc.pid, signal.SIGKILL)


async def run_command(
    cmd: list[str],
    *,
    timeout: float,
    cancel: asyncio.Event | None = None,
    env: dict[str, str] | None = None,
    on_stdout_line: Callable[[str], None] | None = None,
) -> tuple[int, str, str]:
    """Run a command; returns (returncode, stdout, stderr_tail). Raises JobCancelled / MediaError(timeout)."""
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env or safe_env(),
        start_new_session=(os.name != "nt"),
    )
    assert proc.stdout and proc.stderr
    out_lines: list[str] = []
    err_tail: deque[str] = deque(maxlen=60)

    async def read_out() -> None:
        async for raw in proc.stdout:  # type: ignore[union-attr]
            line = raw.decode("utf-8", "replace").rstrip()
            if on_stdout_line:
                on_stdout_line(line)
            else:
                out_lines.append(line)

    async def read_err() -> None:
        async for raw in proc.stderr:  # type: ignore[union-attr]
            err_tail.append(raw.decode("utf-8", "replace").rstrip())

    readers = asyncio.gather(read_out(), read_err())
    waiter = asyncio.ensure_future(proc.wait())
    cancel_task = asyncio.ensure_future(cancel.wait()) if cancel else None
    try:
        done, _ = await asyncio.wait(
            {waiter} | ({cancel_task} if cancel_task else set()), timeout=timeout, return_when=asyncio.FIRST_COMPLETED
        )
        if not done:
            _kill(proc)
            await proc.wait()
            raise MediaError("timeout", f"{Path(cmd[0]).name} did not finish within {int(timeout)} seconds")
        if cancel_task is not None and cancel_task in done and waiter not in done:
            _kill(proc)
            await proc.wait()
            raise JobCancelled()
        await readers
    finally:
        _kill(proc)
        for task in (waiter, cancel_task):
            if task is not None and not task.done():
                task.cancel()
        with contextlib.suppress(Exception):
            await asyncio.wait_for(readers, timeout=5)
    return proc.returncode or 0, "\n".join(out_lines), "\n".join(err_tail)


# ───────────────────────────────── probing ─────────────────────────────────


@dataclass
class StreamInfo:
    index: int
    kind: str  # video | audio | subtitle | data
    codec: str | None
    width: int | None = None
    height: int | None = None
    fps: float | None = None
    pix_fmt: str | None = None
    color_transfer: str | None = None
    channels: int | None = None
    sample_rate: int | None = None
    bit_rate: int | None = None
    language: str | None = None
    attached_pic: bool = False


@dataclass
class Probe:
    path: str
    size: int
    format_name: str
    duration: float | None
    bit_rate: int | None
    tags: dict[str, str]
    streams: list[StreamInfo] = field(default_factory=list)

    @property
    def video(self) -> StreamInfo | None:
        return next((s for s in self.streams if s.kind == "video" and not s.attached_pic), None)

    @property
    def audio(self) -> StreamInfo | None:
        return next((s for s in self.streams if s.kind == "audio"), None)

    def to_dict(self) -> dict[str, Any]:
        v, a = self.video, self.audio
        return {
            "size": self.size,
            "format": self.format_name,
            "duration": self.duration,
            "video": None if not v else {"codec": v.codec, "width": v.width, "height": v.height, "fps": v.fps},
            "audio": None if not a else {"codec": a.codec, "channels": a.channels, "sampleRate": a.sample_rate},
        }


def _rate(value: str | None) -> float | None:
    if not value or "/" not in value:
        return None
    num, _, den = value.partition("/")
    try:
        return round(float(num) / float(den), 3) if float(den) else None
    except ValueError:
        return None


def _int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def parse_probe(path: str, payload: dict[str, Any]) -> Probe:
    fmt = payload.get("format") or {}
    streams: list[StreamInfo] = []
    for s in payload.get("streams") or []:
        disposition = s.get("disposition") or {}
        streams.append(
            StreamInfo(
                index=int(s.get("index", 0)),
                kind=str(s.get("codec_type") or "data"),
                codec=s.get("codec_name"),
                width=_int(s.get("width")),
                height=_int(s.get("height")),
                fps=_rate(s.get("avg_frame_rate")) or _rate(s.get("r_frame_rate")),
                pix_fmt=s.get("pix_fmt"),
                color_transfer=s.get("color_transfer"),
                channels=_int(s.get("channels")),
                sample_rate=_int(s.get("sample_rate")),
                bit_rate=_int(s.get("bit_rate")),
                language=(s.get("tags") or {}).get("language"),
                attached_pic=bool(disposition.get("attached_pic")),
            )
        )
    try:
        duration = float(fmt["duration"]) if fmt.get("duration") not in (None, "N/A") else None
    except (TypeError, ValueError):
        duration = None
    return Probe(
        path=path,
        size=_int(fmt.get("size")) or (os.path.getsize(path) if os.path.exists(path) else 0),
        format_name=str(fmt.get("format_name") or ""),
        duration=duration,
        bit_rate=_int(fmt.get("bit_rate")),
        tags={str(k).lower(): str(v) for k, v in (fmt.get("tags") or {}).items()},
        streams=streams,
    )


async def probe(settings: Settings, path: Path | str, *, timeout: float = 120) -> Probe:
    cmd = [
        settings.ffprobe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", "--", str(path),
    ]
    code, out, err = await run_command(cmd, timeout=timeout)
    if code != 0:
        raise MediaError("validation_failed", f"ffprobe could not read the file: {err.strip()[-300:]}", retryable=False)
    try:
        return parse_probe(str(path), json.loads(out))
    except ValueError as exc:
        raise MediaError("validation_failed", "ffprobe returned invalid JSON", retryable=False) from exc


# FFmpeg reaches https:// through an HTTP proxy with its internal `httpproxy` protocol (CONNECT tunnel); without it in the
# whitelist every https source fails behind the policy proxy ("Protocol 'httpproxy' not on whitelist" — found by the live test).
REMOTE_PROTOCOLS = "http,https,httpproxy,tcp,tls,crypto"


async def probe_url(settings: Settings, url: str, *, timeout: float = 45) -> Probe:
    """FFprobe a remote media URL. All traffic goes through the policy proxy (FFmpeg honours http_proxy)."""
    cmd = [
        settings.ffprobe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams",
        "-rw_timeout", "20000000", "-protocol_whitelist", REMOTE_PROTOCOLS, "--", url,
    ]
    code, out, err = await run_command(cmd, timeout=timeout, env=safe_env(settings.policy_proxy_url))
    if code != 0:
        raise MediaError("unavailable", f"ffprobe could not read the remote file: {err.strip()[-200:]}", retryable=False)
    try:
        return parse_probe(url, json.loads(out))
    except ValueError as exc:
        raise MediaError("unavailable", "ffprobe returned invalid JSON", retryable=False) from exc


# ───────────────────────────────── stream planning ─────────────────────────────────

_MP4_AUDIO_COPY = ("aac", "mp3", "ac3", "eac3", "opus", "flac", "alac")


@dataclass
class StreamPlan:
    video: str  # "copy" | "encode" | "none"
    audio: str  # "copy" | "encode" | "none"
    notes: list[str] = field(default_factory=list)


def plan_streams(pr: Probe, container: str, allow_transcode: bool) -> StreamPlan:
    """Decide copy vs re-encode per stream. Prefers remux; raises MediaError(format_unavailable) when a
    re-encode would be needed but the user did not allow it (we explain instead of silently converting)."""
    v, a = pr.video, pr.audio
    plan = StreamPlan(video="copy" if v else "none", audio="copy" if a else "none")
    if container == "original":
        return plan
    ok, reason = container_compat(v.codec if v else None, a.codec if a else None, container)
    if ok:
        return plan
    if not allow_transcode:
        raise MediaError(
            "format_unavailable",
            f"{reason}. Re-encoding would be required; choose another container or allow conversion.",
            retryable=False,
        )
    # work out which side needs re-encoding
    if v:
        v_ok, _ = container_compat(v.codec, None, container)
        if not v_ok:
            plan.video = "encode"
            plan.notes.append(f"re-encoding video {v.codec} for {container}")
    if a:
        a_ok, _ = container_compat(None, a.codec, container)
        if not a_ok:
            plan.audio = "encode"
            plan.notes.append(f"re-encoding audio {a.codec} for {container}")
    return plan


# ───────────────────────────────── finalise (container + metadata) ─────────────────────────────────

_CONTAINER_EXT = {"mp4": ".mp4", "webm": ".webm", "mkv": ".mkv", "mp3": ".mp3", "m4a": ".m4a"}
_MUXER = {"mp4": "mp4", "webm": "webm", "mkv": "matroska", "mp3": "mp3", "m4a": "ipod"}


def container_extension(container: str, src: Path) -> str:
    return _CONTAINER_EXT.get(container, src.suffix or ".mp4")


def _metadata_args(title: str | None, artist: str | None) -> list[str]:
    args: list[str] = []
    if title:
        args += ["-metadata", f"title={title}"]
    if artist:
        args += ["-metadata", f"artist={artist}"]
    return args


async def finalize_video(
    settings: Settings,
    src: Path,
    dst: Path,
    *,
    container: str,
    plan: StreamPlan,
    pr: Probe,
    title: str | None,
    artist: str | None,
    timeout: float,
    cancel: asyncio.Event | None = None,
    on_percent: Callable[[float], None] | None = None,
) -> None:
    """One FFmpeg pass: put the streams into `container`, write metadata, enable faststart."""
    muxer = _MUXER.get(container)
    cmd = [settings.ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-progress", "pipe:1", "-nostats"]
    cmd += ["-i", str(src), "-map", "0:v:0", "-map", "0:a:0?", "-dn", "-sn", "-map_metadata", "0"]
    if plan.video == "encode":
        if container == "webm":
            cmd += ["-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-row-mt", "1"]
        else:
            cmd += [
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
                "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
            ]
    else:
        cmd += ["-c:v", "copy"]
        if pr.video and pr.video.codec == "hevc" and container in ("mp4", "original"):
            cmd += ["-tag:v", "hvc1"]  # Apple/Telegram players need the hvc1 tag
    if plan.audio == "encode":
        cmd += ["-c:a", "libopus", "-b:a", "160k"] if container == "webm" else ["-c:a", "aac", "-b:a", "192k"]
    else:
        cmd += ["-c:a", "copy"]
    cmd += _metadata_args(title, artist)
    if container in ("mp4", "m4a") or (container == "original" and dst.suffix.lower() in (".mp4", ".m4v", ".mov")):
        cmd += ["-movflags", "+faststart"]
    if muxer:
        cmd += ["-f", muxer]
    cmd += [str(dst)]

    await _run_ffmpeg(cmd, pr.duration, timeout, cancel, on_percent)


async def finalize_audio(
    settings: Settings,
    src: Path,
    dst: Path,
    *,
    container: str,
    pr: Probe,
    title: str | None,
    artist: str | None,
    timeout: float,
    cancel: asyncio.Event | None = None,
    on_percent: Callable[[float], None] | None = None,
) -> None:
    """Audio-only output: copy when the codec fits the requested container, otherwise encode (mp3/m4a)."""
    codec = pr.audio.codec if pr.audio else None
    cmd = [settings.ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-progress", "pipe:1", "-nostats"]
    cmd += ["-i", str(src), "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "0"]
    if container == "mp3":
        cmd += ["-c:a", "copy"] if codec == "mp3" else ["-c:a", "libmp3lame", "-b:a", "192k"]
        cmd += ["-id3v2_version", "3"]
    elif container == "m4a":
        cmd += ["-c:a", "copy"] if codec in ("aac", "alac") else ["-c:a", "aac", "-b:a", "192k"]
        cmd += ["-movflags", "+faststart"]
    else:  # original
        cmd += ["-c:a", "copy"]
    cmd += _metadata_args(title, artist)
    muxer = _MUXER.get(container)
    if muxer:
        cmd += ["-f", muxer]
    cmd += [str(dst)]
    await _run_ffmpeg(cmd, pr.duration, timeout, cancel, on_percent)


async def _run_ffmpeg(
    cmd: list[str],
    duration: float | None,
    timeout: float,
    cancel: asyncio.Event | None,
    on_percent: Callable[[float], None] | None,
) -> None:
    def on_line(line: str) -> None:
        if on_percent and duration and line.startswith(("out_time_us=", "out_time_ms=")):
            try:
                micro = int(line.split("=", 1)[1])
            except ValueError:
                return
            on_percent(min(max(micro / 1_000_000 / duration * 100.0, 0.0), 100.0))

    code, _, err = await run_command(cmd, timeout=timeout, cancel=cancel, on_stdout_line=on_line)
    if code != 0:
        raise MediaError("ffmpeg_failed", f"ffmpeg exited with code {code}: {err.strip()[-400:]}")


# ───────────────────────────────── frames ─────────────────────────────────


async def extract_frame(
    settings: Settings,
    source: str,
    timestamp: float,
    out: Path,
    *,
    proxy: str | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 60,
    cancel: asyncio.Event | None = None,
) -> bool:
    """Grab one JPEG frame from a local file or (through the policy proxy) a remote URL."""
    cmd = [settings.ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y"]
    if source.startswith(("http://", "https://")):
        if proxy:
            cmd += ["-http_proxy", proxy]
        if headers:
            cmd += ["-headers", "".join(f"{k}: {v}\r\n" for k, v in headers.items() if "\n" not in v and "\r" not in v)]
        cmd += ["-rw_timeout", "20000000", "-protocol_whitelist", f"{REMOTE_PROTOCOLS},hls,file"]
    cmd += ["-ss", f"{max(timestamp, 0):.3f}", "-i", source, "-frames:v", "1", "-update", "1", "-q:v", "2", str(out)]
    # remote sources: also set http_proxy in the environment so HLS/DASH sub-requests cannot bypass the policy proxy
    env = safe_env(proxy) if (proxy and source.startswith(("http://", "https://"))) else None
    code, _, _ = await run_command(cmd, timeout=timeout, cancel=cancel, env=env)
    return code == 0 and out.exists() and out.stat().st_size > 0


# ───────────────────────────────── validation ─────────────────────────────────


@dataclass
class ValidationReport:
    ok: bool
    errors: list[str]
    warnings: list[str]
    probe: Probe | None

    def summary(self) -> dict[str, Any]:
        return {"ok": self.ok, "errors": self.errors, "warnings": self.warnings, "probe": self.probe.to_dict() if self.probe else None}


_FORMAT_NAMES = {
    "mp4": ("mp4", "mov", "m4a", "3gp"),
    "webm": ("webm", "matroska"),
    "mkv": ("matroska",),
    "mp3": ("mp3",),
    "m4a": ("mp4", "m4a", "mov"),
}


async def validate_output(
    settings: Settings,
    path: Path,
    *,
    kind: str,
    container: str,
    max_bytes: int,
    expected_height_short_side: int | None = None,
    source_duration: float | None = None,
) -> ValidationReport:
    errors: list[str] = []
    warnings: list[str] = []
    if not path.exists():
        return ValidationReport(False, ["output file does not exist"], warnings, None)
    size = path.stat().st_size
    if size <= 0:
        return ValidationReport(False, ["output file is empty"], warnings, None)
    if size > max_bytes:
        errors.append(f"output is {size} bytes, above the configured limit of {max_bytes}")
    try:
        pr = await probe(settings, path)
    except MediaError as exc:
        return ValidationReport(False, [*errors, exc.message], warnings, None)

    if kind == "video":
        if pr.video is None:
            errors.append("output has no video stream")
        elif not pr.video.width or not pr.video.height:
            errors.append("video stream has no resolution")
        if pr.audio is None:
            warnings.append("output has no audio stream (the source may be silent)")
    else:
        if pr.audio is None:
            errors.append("output has no audio stream")
    if not pr.duration or pr.duration <= 0:
        errors.append("output has no duration")
    elif source_duration and abs(pr.duration - source_duration) > max(3.0, source_duration * 0.10):
        warnings.append(f"duration {pr.duration:.1f}s differs from the source's {source_duration:.1f}s")

    names = _FORMAT_NAMES.get(container)
    if names and not any(n in pr.format_name.split(",") for n in names):
        errors.append(f"container is {pr.format_name!r}, expected {container}")

    if kind == "video" and expected_height_short_side and pr.video and pr.video.width and pr.video.height:
        actual = min(pr.video.width, pr.video.height)
        if actual < expected_height_short_side * 0.8:
            errors.append(f"resolution {actual}p is far below the selected {expected_height_short_side}p")
        elif abs(actual - expected_height_short_side) > 8:
            warnings.append(f"resolution is {actual}p, selected {expected_height_short_side}p")
    return ValidationReport(not errors, errors, warnings, pr)
