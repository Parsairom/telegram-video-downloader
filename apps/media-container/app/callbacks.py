"""Container -> Worker reporting. Events are authenticated with the per-job token handed over at start."""
from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import Callable
from typing import Any

import httpx

log = logging.getLogger("tvd.reporter")

PROGRESS_MIN_INTERVAL = 2.5  # seconds between progress events (the Worker throttles Telegram edits again)
HEARTBEAT_INTERVAL = 20.0


class Reporter:
    def __init__(
        self,
        base_url: str,
        job_id: str,
        token: str,
        correlation_id: str,
        *,
        client: httpx.AsyncClient | None = None,
        on_cancel: Callable[[], None] | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.job_id = job_id
        self.token = token
        self.correlation_id = correlation_id
        self._client = client or httpx.AsyncClient(timeout=httpx.Timeout(15.0))
        self._owns_client = client is None
        self._last_progress = 0.0
        self._on_cancel = on_cancel
        self._heartbeat: asyncio.Task | None = None

    @property
    def url(self) -> str:
        return f"{self.base_url}/internal/jobs/{self.job_id}/events"

    @property
    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}", "X-Correlation-Id": self.correlation_id}

    async def _post(self, event: dict[str, Any], *, attempts: int) -> bool:
        delay = 1.0
        for attempt in range(1, attempts + 1):
            try:
                resp = await self._client.post(self.url, json=event, headers=self.headers)
                if resp.status_code < 300:
                    with contextlib.suppress(ValueError):
                        if resp.json().get("cancel") and self._on_cancel:
                            self._on_cancel()
                    return True
                if resp.status_code in (401, 403, 404, 409, 410):
                    log.warning("worker rejected event %s: HTTP %s", event.get("type"), resp.status_code)
                    return False
            except httpx.HTTPError as exc:
                log.info("event %s failed (attempt %s): %s", event.get("type"), attempt, type(exc).__name__)
            if attempt < attempts:
                await asyncio.sleep(delay)
                delay = min(delay * 2, 20)
        return False

    async def state(self, status: str) -> None:
        await self._post({"type": "state", "status": status}, attempts=6)

    async def progress(self, progress: dict[str, Any], *, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self._last_progress < PROGRESS_MIN_INTERVAL:
            return
        self._last_progress = now
        await self._post({"type": "progress", "progress": progress}, attempts=1)

    async def completed(self, result: dict[str, Any]) -> bool:
        return await self._post({"type": "completed", "result": result}, attempts=8)

    async def failed(self, code: str, message: str, retryable: bool) -> bool:
        return await self._post(
            {"type": "failed", "errorCode": code, "message": message[:500], "retryable": retryable}, attempts=8
        )

    def start_heartbeat(self) -> None:
        async def beat() -> None:
            while True:
                await asyncio.sleep(HEARTBEAT_INTERVAL)
                await self._post({"type": "heartbeat"}, attempts=1)

        self._heartbeat = asyncio.ensure_future(beat())

    async def close(self) -> None:
        if self._heartbeat:
            self._heartbeat.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._heartbeat
        if self._owns_client:
            await self._client.aclose()
