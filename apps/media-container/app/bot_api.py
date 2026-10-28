"""Optional local Telegram Bot API server (tdlib/telegram-bot-api in --local mode) running inside this container.

It lifts the upload limit from 50 MB (cloud Bot API) to 2000 MB, and lets us hand it a file *path*
(`file:///work/...`) so a 1.9 GB video is never copied through HTTP. It is only started when
LOCAL_BOT_API_ENABLED=true, the binary is present in the image, and TELEGRAM_API_ID/HASH are set.

IMPORTANT (see docs/large-file-delivery.md): a bot that is served by a local server must first be logged
out of the cloud Bot API, and cannot return to the cloud server for ten minutes. This component is
shipped but its end-to-end behaviour on Cloudflare Containers is marked UNVERIFIED until it has been
exercised against a real bot with real API credentials.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import shutil

import httpx

from .config import Settings
from .security import safe_env

log = logging.getLogger("tvd.botapi")


class LocalBotApi:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.proc: asyncio.subprocess.Process | None = None
        self.binary = shutil.which("telegram-bot-api")

    @property
    def available(self) -> bool:
        return bool(
            self.settings.local_bot_api_enabled
            and self.binary
            and self.settings.telegram_api_id
            and self.settings.telegram_api_hash
        )

    def unavailable_reason(self) -> str | None:
        if not self.settings.local_bot_api_enabled:
            return "LOCAL_BOT_API_ENABLED is not set"
        if not self.binary:
            return "telegram-bot-api binary is not in this image (build with --build-arg WITH_LOCAL_BOT_API=1)"
        if not (self.settings.telegram_api_id and self.settings.telegram_api_hash):
            return "TELEGRAM_API_ID / TELEGRAM_API_HASH are not set"
        return None

    async def start(self) -> bool:
        if not self.available:
            reason = self.unavailable_reason()
            if self.settings.local_bot_api_enabled:
                log.warning("local Bot API not started: %s", reason)
            return False
        data_dir = self.settings.work_dir / "botapi"
        tmp_dir = self.settings.work_dir / "botapi-tmp"
        data_dir.mkdir(parents=True, exist_ok=True)
        tmp_dir.mkdir(parents=True, exist_ok=True)
        port = self.settings.local_bot_api_url.rsplit(":", 1)[-1]
        # credentials go through the environment, not argv (argv is visible in `ps`)
        env = safe_env(None, {
            "TELEGRAM_API_ID": self.settings.telegram_api_id or "",
            "TELEGRAM_API_HASH": self.settings.telegram_api_hash or "",
        })
        self.proc = await asyncio.create_subprocess_exec(
            self.binary or "telegram-bot-api",
            "--local",
            f"--http-port={port}",
            "--http-ip-address=127.0.0.1",
            f"--dir={data_dir}",
            f"--temp-dir={tmp_dir}",
            "--verbosity=1",
            env=env,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        for _ in range(40):
            if await self.healthy():
                log.info("local Bot API server is up on port %s", port)
                return True
            if self.proc.returncode is not None:
                break
            await asyncio.sleep(0.5)
        log.error("local Bot API server failed to become healthy")
        await self.stop()
        return False

    async def healthy(self) -> bool:
        """The server answers HTTP once it is listening; an unknown path returns a JSON error, not a refusal."""
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                resp = await client.get(f"{self.settings.local_bot_api_url}/")
                return resp.status_code < 500
        except httpx.HTTPError:
            return False

    async def stop(self) -> None:
        if self.proc and self.proc.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                self.proc.terminate()
            try:
                await asyncio.wait_for(self.proc.wait(), timeout=10)
            except TimeoutError:
                with contextlib.suppress(ProcessLookupError):
                    self.proc.kill()
        self.proc = None

    @staticmethod
    def disk_hint() -> int:
        return os.statvfs("/").f_bavail if hasattr(os, "statvfs") else 0
