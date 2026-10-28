"""Runs yt-dlp in an isolated subprocess with timeout, cancellation and progress reporting."""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import shutil
import signal
import sys
from collections import deque
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .config import Settings
from .errors import JobCancelled, MediaError, classify_error
from .security import safe_env

log = logging.getLogger("tvd.download")
APP_ROOT = Path(__file__).resolve().parent.parent  # directory that contains the `app` package

ProgressCallback = Callable[[dict[str, Any]], None]


def _kill_tree(proc: asyncio.subprocess.Process) -> None:
    if proc.returncode is not None:
        return
    with contextlib.suppress(ProcessLookupError, PermissionError):
        if os.name == "nt":
            proc.kill()
        else:
            os.killpg(proc.pid, signal.SIGKILL)


async def run_ytdlp(
    settings: Settings,
    request: dict[str, Any],
    *,
    timeout: float,
    on_progress: ProgressCallback | None = None,
    cancel: asyncio.Event | None = None,
) -> dict[str, Any]:
    """Run one yt-dlp operation; return its `data` payload or raise MediaError / JobCancelled."""
    request = {
        **request,
        "proxy": settings.policy_proxy_url,
        "socketTimeout": settings.ytdlp_socket_timeout,
        "jsRuntime": settings.js_runtime,
        "cookiesFile": settings.cookies_file,
        # yt-dlp wants a *path*; a bare "ffmpeg" would be resolved relative to the working directory
        "ffmpeg": shutil.which(settings.ffmpeg),
    }
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "app.ytdlp_worker",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=str(APP_ROOT),
        env=safe_env(settings.policy_proxy_url, {"PYTHONPATH": str(APP_ROOT)}),
        start_new_session=(os.name != "nt"),
    )
    assert proc.stdin and proc.stdout and proc.stderr
    proc.stdin.write(json.dumps(request).encode())
    await proc.stdin.drain()
    proc.stdin.close()

    result: dict[str, Any] | None = None
    error: dict[str, Any] | None = None
    stderr_tail: deque[str] = deque(maxlen=40)

    async def read_stdout() -> None:
        nonlocal result, error
        async for raw in proc.stdout:  # type: ignore[union-attr]
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            kind = msg.get("type")
            if kind == "progress" and on_progress:
                on_progress(msg)
            elif kind == "result":
                result = msg.get("data")
            elif kind == "error":
                error = msg

    async def read_stderr() -> None:
        async for raw in proc.stderr:  # type: ignore[union-attr]
            stderr_tail.append(raw.decode("utf-8", "replace").rstrip())

    readers = asyncio.gather(read_stdout(), read_stderr())
    waiter = asyncio.ensure_future(proc.wait())
    cancel_task = asyncio.ensure_future(cancel.wait()) if cancel else None
    pending = {waiter} | ({cancel_task} if cancel_task else set())
    try:
        done, _ = await asyncio.wait(pending, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
        if not done:
            _kill_tree(proc)
            await proc.wait()
            raise MediaError("timeout", f"yt-dlp did not finish within {int(timeout)} seconds")
        if cancel_task is not None and cancel_task in done and waiter not in done:
            _kill_tree(proc)
            await proc.wait()
            raise JobCancelled()
        await readers
    finally:
        _kill_tree(proc)
        for task in (waiter, cancel_task):
            if task is not None and not task.done():
                task.cancel()
        with contextlib.suppress(Exception):
            await asyncio.wait_for(readers, timeout=5)

    if result is not None:
        return result
    message = (error or {}).get("message") or "\n".join(stderr_tail) or "yt-dlp failed without output"
    code, retryable = classify_error(message + "\n" + "\n".join(stderr_tail))
    raise MediaError(code, _clean(message), retryable=retryable)


def _clean(message: str) -> str:
    import re

    message = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", message).strip()
    if message.startswith("ERROR:"):
        message = message[len("ERROR:"):].strip()
    return message[:600]
