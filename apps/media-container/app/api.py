"""HTTP API of the media container. The Worker reaches it through the Container Durable Object; the port
is never exposed to the public internet. `CONTAINER_API_KEY` adds a shared-secret check on top."""
from __future__ import annotations

import asyncio
import base64
import logging
import os
import secrets
import shutil
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import yt_dlp
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from .bot_api import LocalBotApi
from .callbacks import Reporter
from .config import Settings, load_settings
from .download import run_ytdlp
from .errors import MediaError
from .extraction import check_url, inspect_url
from .job_runner import JobRunner
from .models import FramesRequest, InspectRequest, StartJobRequest
from .mtproto import MtprotoSender
from .registrar import Registrar
from .security import PolicyProxy
from .thumbnails import preview_frames

log = logging.getLogger("tvd.api")
FINISHED_TTL = 3600


class JobManager:
    def __init__(self, settings: Settings, mtproto: MtprotoSender | None = None):
        self.settings = settings
        self.mtproto = mtproto
        self.sem = asyncio.Semaphore(settings.max_concurrent_jobs)
        self.jobs: dict[str, _Entry] = {}

    def start(self, req: StartJobRequest) -> dict[str, Any]:
        """Idempotent: starting an id that already exists just returns its current state."""
        self._gc()
        existing = self.jobs.get(req.jobId)
        if existing:
            return existing.runner.state.to_dict()
        cancel = asyncio.Event()
        reporter = Reporter(req.callback.baseUrl, req.jobId, req.callback.token, req.correlationId, on_cancel=cancel.set)
        runner = JobRunner(self.settings, req, reporter, cancel, self.mtproto)
        runner.state.phase = "waiting"
        entry = _Entry(runner=runner, cancel=cancel, task=asyncio.ensure_future(self._run(runner)))
        self.jobs[req.jobId] = entry
        return runner.state.to_dict()

    async def _run(self, runner: JobRunner) -> None:
        async with self.sem:
            await runner.run()
        runner.state.started_at = time.time()  # reused as "finished at" for gc

    def get(self, job_id: str) -> dict[str, Any]:
        entry = self.jobs.get(job_id)
        if not entry:
            return {"jobId": job_id, "state": "unknown", "phase": None, "progress": None, "result": None, "errorCode": None, "message": None}
        return entry.runner.state.to_dict()

    def cancel(self, job_id: str) -> bool:
        entry = self.jobs.get(job_id)
        if not entry:
            return False
        entry.cancel.set()
        return True

    async def delete(self, job_id: str) -> None:
        entry = self.jobs.pop(job_id, None)
        if entry:
            entry.cancel.set()
        await asyncio.to_thread(shutil.rmtree, self.settings.work_dir / job_id, True)

    @property
    def active(self) -> int:
        return sum(1 for e in self.jobs.values() if e.runner.state.state == "running")

    async def shutdown(self) -> None:
        """SIGTERM: tell the Worker the running jobs were interrupted so it can retry them promptly."""
        for entry in self.jobs.values():
            if entry.runner.state.state == "running":
                entry.runner.shutting_down = True
                entry.cancel.set()
        tasks = [e.task for e in self.jobs.values() if not e.task.done()]
        if tasks:
            await asyncio.wait(tasks, timeout=20)

    def _gc(self) -> None:
        now = time.time()
        for job_id, entry in list(self.jobs.items()):
            if entry.task.done() and now - entry.runner.state.started_at > FINISHED_TTL:
                self.jobs.pop(job_id, None)


class _Entry:
    def __init__(self, runner: JobRunner, cancel: asyncio.Event, task: asyncio.Future):
        self.runner, self.cancel, self.task = runner, cancel, task


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()
    logging.basicConfig(level=getattr(logging, settings.log_level.upper(), logging.INFO),
                        format='{"ts":"%(asctime)s","level":"%(levelname)s","logger":"%(name)s","msg":"%(message)s"}')
    proxy = PolicyProxy(port=settings.policy_proxy_port, allow_private=settings.allow_private_networks, upstream=settings.upstream_proxy)
    bot_api = LocalBotApi(settings)
    mtproto = MtprotoSender(settings)
    jobs = JobManager(settings, mtproto)
    registrar = Registrar(settings, lambda: {"activeJobs": jobs.active, "maxConcurrentJobs": settings.max_concurrent_jobs})
    frames_sem = asyncio.Semaphore(2)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        settings.work_dir.mkdir(parents=True, exist_ok=True)
        await proxy.start()
        await bot_api.start()
        mtproto_task = asyncio.ensure_future(mtproto.start()) if mtproto.available else None  # warms the peer cache in the background
        registrar.start()
        try:
            yield
        finally:
            await registrar.stop()
            await jobs.shutdown()
            if mtproto_task is not None:
                mtproto_task.cancel()
            await mtproto.close()
            await bot_api.stop()
            await proxy.stop()

    app = FastAPI(title="tvd-media-container", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.settings, app.state.jobs, app.state.proxy, app.state.bot_api = settings, jobs, proxy, bot_api
    app.state.mtproto, app.state.registrar = mtproto, registrar

    async def require_key(request: Request) -> None:
        if not settings.api_key:
            return
        supplied = request.headers.get("authorization", "")
        if not secrets.compare_digest(supplied, f"Bearer {settings.api_key}"):
            raise HTTPException(status_code=401, detail="unauthorized")

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {"ok": True}

    @app.get("/diagnostics", dependencies=[Depends(require_key)])
    async def diagnostics() -> dict[str, Any]:
        free = shutil.disk_usage(settings.work_dir).free
        return {
            "ok": True,
            "ytdlp": yt_dlp.version.__version__,
            "ffmpeg": shutil.which(settings.ffmpeg) is not None,
            "ffprobe": shutil.which(settings.ffprobe) is not None,
            "diskFreeBytes": free,
            "activeJobs": jobs.active,
            "maxConcurrentJobs": settings.max_concurrent_jobs,
            "policyProxy": {"allowed": proxy.stats.allowed, "blocked": proxy.stats.blocked},
            "localBotApi": {"enabled": settings.local_bot_api_enabled, "available": bot_api.available,
                            "healthy": await bot_api.healthy() if bot_api.available else False,
                            "reason": bot_api.unavailable_reason()},
            "mtproto": {"enabled": mtproto.available, "connected": mtproto.connected},
            "registration": {"enabled": registrar.enabled, "workerBaseUrl": settings.worker_base_url, "publicUrl": settings.engine_public_url},
            "upstreamProxy": bool(settings.upstream_proxy),
            "jsRuntime": settings.js_runtime,
        }

    @app.post("/inspect", dependencies=[Depends(require_key)])
    async def inspect(body: InspectRequest) -> JSONResponse:
        try:
            data = await inspect_url(settings, body.url, body.correlationId)
            return JSONResponse({"ok": True, "data": data})
        except MediaError as exc:
            return JSONResponse({"ok": False, "error": exc.to_dict()})

    @app.post("/frames", dependencies=[Depends(require_key)])
    async def frames(body: FramesRequest) -> JSONResponse:
        """Preview frames of a remote stream so the user can pick a thumbnail before downloading."""
        try:
            url = check_url(settings, body.url)
            async with frames_sem:
                resolved = await run_ytdlp(
                    settings, {"mode": "resolve", "url": url, "videoFormatId": body.formatId}, timeout=90
                )
                duration = body.durationSeconds or resolved.get("duration") or 0
                if duration <= 0:
                    raise MediaError("unavailable", "the video has no known duration, cannot sample frames", retryable=False)
                workdir = settings.work_dir / f"frames-{secrets.token_hex(6)}"
                try:
                    found = await preview_frames(
                        settings, resolved["url"], resolved.get("headers") or {}, float(duration), workdir, count=body.count
                    )
                    payload = [
                        {"timestamp": round(ts, 2), "jpegBase64": base64.b64encode(Path(p).read_bytes()).decode()}
                        for ts, p in found
                    ]
                finally:
                    await asyncio.to_thread(shutil.rmtree, workdir, True)
            if not payload:
                raise MediaError("unavailable", "no usable preview frames could be extracted", retryable=False)
            return JSONResponse({"ok": True, "data": {"frames": payload}})
        except MediaError as exc:
            return JSONResponse({"ok": False, "error": exc.to_dict()})

    @app.post("/jobs", status_code=202, dependencies=[Depends(require_key)])
    async def start_job(body: StartJobRequest) -> dict[str, Any]:
        return jobs.start(body)

    @app.get("/jobs/{job_id}", dependencies=[Depends(require_key)])
    async def job_status(job_id: str) -> dict[str, Any]:
        return jobs.get(job_id)

    @app.post("/jobs/{job_id}/cancel", dependencies=[Depends(require_key)])
    async def cancel_job(job_id: str) -> dict[str, Any]:
        return {"cancelled": jobs.cancel(job_id)}

    @app.delete("/jobs/{job_id}", dependencies=[Depends(require_key)])
    async def delete_job(job_id: str) -> dict[str, Any]:
        await jobs.delete(job_id)
        return {"deleted": True}

    return app


# `uvicorn app.api:app` — tests set TVD_NO_AUTOAPP=1 and call create_app() with their own settings.
app = None if os.environ.get("TVD_NO_AUTOAPP") else create_app()
