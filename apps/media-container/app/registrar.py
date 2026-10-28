"""Self-hosted engine: tell the Worker where this engine can be reached.

On the free Cloudflare plan there are no Containers, so the media engine runs on your own machine behind a Cloudflare
Tunnel whose public URL changes whenever the tunnel restarts. The engine therefore registers itself with the Worker on
start-up and every 30 seconds (a heartbeat); the Worker only sends work to an engine that was seen recently.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Callable
from typing import Any

import httpx
import yt_dlp

from .config import Settings

log = logging.getLogger("tvd.registrar")
INTERVAL_SECONDS = 30.0


class Registrar:
    def __init__(self, settings: Settings, status: Callable[[], dict[str, Any]]):
        self.settings = settings
        self._status = status
        self._task: asyncio.Task | None = None

    @property
    def enabled(self) -> bool:
        s = self.settings
        return bool(s.worker_base_url and s.engine_public_url and s.api_key)

    def start(self) -> None:
        if self.enabled and self._task is None:
            self._task = asyncio.ensure_future(self._loop())
            log.info("registering %s with %s every %ss", self.settings.engine_public_url, self.settings.worker_base_url, int(INTERVAL_SECONDS))

    async def stop(self) -> None:
        task, self._task = self._task, None
        if task:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        if self.enabled:
            await self._post({"url": None})  # tell the Worker this engine is going away

    def _payload(self) -> dict[str, Any]:
        s = self.settings
        return {
            "url": s.engine_public_url,
            "name": s.engine_name,
            "ytdlp": yt_dlp.version.__version__,
            "capabilities": {"mtproto": s.mtproto_enabled, "localBotApi": s.local_bot_api_enabled},
            **self._status(),
        }

    async def _post(self, body: dict[str, Any]) -> bool:
        s = self.settings
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(15.0)) as client:
                resp = await client.post(
                    f"{s.worker_base_url}/internal/engine/register",
                    json=body,
                    headers={"Authorization": f"Bearer {s.api_key}"},
                )
            if resp.status_code >= 300:
                log.warning("Worker rejected the registration: HTTP %s", resp.status_code)
            return resp.status_code < 300
        except httpx.HTTPError as exc:
            log.info("registration failed: %s", type(exc).__name__)
            return False

    async def _loop(self) -> None:
        while True:
            await self._post(self._payload())
            await asyncio.sleep(INTERVAL_SECONDS)
