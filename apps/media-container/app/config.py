"""Container settings, read from environment variables.

Two deployment profiles use the same code:
* Cloudflare Container (paid plan): the Worker's Container class sets the variables.
* Self-hosted engine (free plan): `scripts/run-engine.mjs` sets them from `.env` on your own machine; the engine
  then registers its public (tunnel) URL with the Worker (see registrar.py).
"""
from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from pathlib import Path


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "").strip() or default)
    except ValueError:
        return default


def _bool(name: str, default: bool = False) -> bool:
    value = os.environ.get(name, "").strip().lower()
    return default if not value else value in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    port: int
    work_dir: Path
    log_level: str
    api_key: str | None  # Worker -> engine shared secret
    bot_token: str | None
    local_bot_token: str | None  # optional separate delivery bot for the local server (see docs/large-file-delivery.md)
    telegram_api_base: str
    local_bot_api_enabled: bool
    local_bot_api_url: str
    telegram_api_id: str | None
    telegram_api_hash: str | None
    cloud_upload_limit_bytes: int
    local_upload_limit_bytes: int
    mtproto_upload_limit_bytes: int
    mtproto_session: Path
    max_concurrent_jobs: int
    min_free_disk_bytes: int
    policy_proxy_port: int
    allow_private_networks: bool  # ONLY for tests against a localhost fixture server
    js_runtime: str | None
    cookies_file: str | None
    ffmpeg: str
    ffprobe: str
    ytdlp_socket_timeout: int
    telegram_proxy: str | None  # proxy for api.telegram.org / MTProto when Telegram is blocked where the engine runs
    upstream_proxy: str | None  # self-hosted only: chain the policy proxy through this SOCKS5/HTTP proxy
    worker_base_url: str | None  # self-hosted: where to register
    engine_public_url: str | None  # self-hosted: the tunnel URL the Worker reaches this engine on
    engine_name: str

    @property
    def policy_proxy_url(self) -> str:
        return f"http://127.0.0.1:{self.policy_proxy_port}"

    @property
    def mtproto_enabled(self) -> bool:
        """MTProto (Telethon) upload: needs API credentials and the bot token; lifts the limit to ~2 GB."""
        return bool(
            self.telegram_api_id
            and self.telegram_api_hash
            and self.bot_token
            and _bool("MTPROTO_ENABLED", True)
        )


def load_settings() -> Settings:
    work_dir = Path(os.environ.get("WORK_DIR", "/work"))
    return Settings(
        port=_int("PORT", 8080),
        work_dir=work_dir,
        log_level=os.environ.get("LOG_LEVEL", "info").lower(),
        api_key=os.environ.get("CONTAINER_API_KEY") or None,
        bot_token=os.environ.get("BOT_TOKEN") or None,
        local_bot_token=os.environ.get("LOCAL_BOT_TOKEN") or None,
        telegram_api_base=os.environ.get("TELEGRAM_API_BASE", "https://api.telegram.org").rstrip("/"),
        local_bot_api_enabled=_bool("LOCAL_BOT_API_ENABLED", False),
        local_bot_api_url=os.environ.get("LOCAL_BOT_API_URL", "http://127.0.0.1:8081").rstrip("/"),
        telegram_api_id=os.environ.get("TELEGRAM_API_ID") or None,
        telegram_api_hash=os.environ.get("TELEGRAM_API_HASH") or None,
        cloud_upload_limit_bytes=_int("CLOUD_UPLOAD_LIMIT_BYTES", 50 * 1000 * 1000),
        local_upload_limit_bytes=_int("LOCAL_UPLOAD_LIMIT_BYTES", 2000 * 1000 * 1000),
        mtproto_upload_limit_bytes=_int("MTPROTO_UPLOAD_LIMIT_BYTES", 2000 * 1000 * 1000),
        mtproto_session=Path(os.environ.get("MTPROTO_SESSION") or (work_dir / ".mtproto-session")),
        max_concurrent_jobs=max(1, _int("MAX_CONCURRENT_JOBS", 1)),
        min_free_disk_bytes=_int("MIN_FREE_DISK_BYTES", 512 * 1024 * 1024),
        policy_proxy_port=_int("POLICY_PROXY_PORT", 3128),
        allow_private_networks=_bool("ALLOW_PRIVATE_NETWORKS", False),
        js_runtime=os.environ.get("YTDLP_JS_RUNTIME") or ("node" if shutil.which("node") else None),
        cookies_file=os.environ.get("COOKIES_FILE") or None,
        ffmpeg=os.environ.get("FFMPEG_BIN", "ffmpeg"),
        ffprobe=os.environ.get("FFPROBE_BIN", "ffprobe"),
        ytdlp_socket_timeout=_int("YTDLP_SOCKET_TIMEOUT", 30),
        telegram_proxy=os.environ.get("TELEGRAM_PROXY") or None,
        upstream_proxy=os.environ.get("UPSTREAM_PROXY") or None,
        worker_base_url=(os.environ.get("WORKER_BASE_URL") or "").rstrip("/") or None,
        engine_public_url=(os.environ.get("ENGINE_PUBLIC_URL") or "").rstrip("/") or None,
        engine_name=os.environ.get("ENGINE_NAME", "local-engine"),
    )
