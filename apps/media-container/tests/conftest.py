from __future__ import annotations

import dataclasses
import os
import shutil
import threading
import time
from collections.abc import Iterator
from pathlib import Path

import pytest
import uvicorn

os.environ.setdefault("TVD_NO_AUTOAPP", "1")

from app.config import Settings, load_settings  # noqa: E402

HAS_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
needs_ffmpeg = pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg and ffprobe are not on PATH")


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    base = load_settings()
    return dataclasses.replace(
        base,
        work_dir=tmp_path / "work",
        policy_proxy_port=0,
        allow_private_networks=False,
        bot_token="123456:TEST-TOKEN",  # noqa: S106
        api_key=None,
        min_free_disk_bytes=1024,
    )


class ServerThread:
    """Runs a FastAPI/ASGI app on an ephemeral localhost port in a background thread."""

    def __init__(self, app) -> None:
        self.config = uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning", lifespan="off")
        self.server = uvicorn.Server(self.config)
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    def __enter__(self) -> ServerThread:
        self.thread.start()
        deadline = time.time() + 10
        while not self.server.started and time.time() < deadline:
            time.sleep(0.05)
        if not self.server.started:
            raise RuntimeError("test server did not start")
        return self

    @property
    def port(self) -> int:
        return self.server.servers[0].sockets[0].getsockname()[1]

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def __exit__(self, *exc) -> None:
        self.server.should_exit = True
        self.thread.join(timeout=10)


@pytest.fixture
def serve() -> Iterator[type[ServerThread]]:
    yield ServerThread
