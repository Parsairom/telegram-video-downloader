# Operations

Two profiles exist ([`free-plan-hybrid.md`](free-plan-hybrid.md) explains the free one). The scripts default to **free**
(`apps/worker/wrangler.free.jsonc`); add `--paid` to any of `provision`, `secrets`, `deploy` for the Containers/R2 profile
(`apps/worker/wrangler.jsonc`). Sections below say *(paid)* where they apply to that profile only.

## Free profile: running and checking the engine

```bash
npm run engine            # tunnel + media engine on this computer; leave it running
```

* **Is it up?** `/admin health` in the bot: the `container:` line carries the engine's diagnostics (yt-dlp version, free disk, MTProto state) plus `engine.lastSeenSecondsAgo`
  (`ERROR` if it is stale or unreachable). Or look at the engine window:
  a line `POST …/internal/engine/register "HTTP/1.1 200 OK"` every 30 s means the Worker is receiving heartbeats.
* **Bot says the engine is offline** → the engine window is closed/asleep, the computer lost its connection, or the heartbeat is older than 120 s. Restart `npm run engine`.
* **Tunnel keeps failing** → `TUNNEL_PROTOCOL=http2` in `.env` (some networks block QUIC/UDP 7844); the `precheck … fail` lines cloudflared prints are advisory when a
  `Registered tunnel connection` line follows.
* **Port already in use** → change `ENGINE_PORT` (default 18080).
* **Telegram or the source site is blocked on this network** → set `TELEGRAM_PROXY` / `UPSTREAM_PROXY` (SOCKS5 `socks5h://host:port` or HTTP) in `.env`; see the caveat in [`security.md`](security.md).
* **Large file fails with a `telegram_error` mentioning the user/peer** → that user has never messaged the bot while the engine was running: ask them to send any message, then retry.
* **Worker quota** → Workers Free allows 100 000 requests/day and 10 ms CPU per request; the engine's heartbeat costs 2 requests/min (≈ 2 900/day). Watch *Workers → tvd-worker → Metrics* in the dashboard.
* Updating yt-dlp: [`updating-dependencies.md`](updating-dependencies.md), then restart the engine (no Worker deploy needed).

## Configuration reference

Deploy-time values are `vars` in `apps/worker/wrangler.free.jsonc` (free) or `wrangler.jsonc` (paid). `npm run provision` copies that template to a git-ignored `wrangler.free.local.jsonc` / `wrangler.local.jsonc`, records your resource ids there, and every script uses the copy. Secrets are uploaded by `npm run deploy` / `npm run secrets`
from your local `.env`. Every numeric size is in **bytes**.

| Name | Where | Default | Meaning |
|---|---|---|---|
| `BOT_TOKEN` | secret | – | Telegram bot token |
| `TELEGRAM_WEBHOOK_SECRET` | secret | generated | 16–256 chars `A-Za-z0-9_-`, echoed by Telegram on every update |
| `INTERNAL_SIGNING_SECRET` | secret | generated | HMAC key for job tokens and download links |
| `CONTAINER_API_KEY` | secret | generated | Worker → container shared secret |
| `ADMIN_USER_IDS` | secret | empty | comma-separated Telegram ids with admin rights |
| `PUBLIC_BASE_URL` | var (set by deploy) | – | `https://tvd-worker.<subdomain>.workers.dev`; needed for callbacks and links |
| `MAX_OUTPUT_BYTES` | var | `1900000000` | application ceiling per output file |
| `MAX_CONCURRENT_JOBS` | var | `3` | jobs running at once (raise only after measuring; one container each) |
| `MAX_JOBS_PER_USER` | var | `2` | active jobs per user |
| `MAX_QUEUED_JOBS` | var | `40` | waiting jobs before new links are refused |
| `MAX_DURATION_SECONDS` | var | `0` (unlimited) | refuse longer sources |
| `MAX_RETRIES` | var | `3` | automatic retries per job (attempts = retries + 1) |
| `DOWNLOAD_TIMEOUT` / `PROCESSING_TIMEOUT` / `UPLOAD_TIMEOUT` | var | `3600` / `1800` / `3600` s | per-phase limits inside the container |
| `MAX_TEMP_BYTES` | var | `14000000000` | refuse a job that cannot fit the container disk |
| `TEMP_DIRECTORY` | var | `/work` | work directory in the container |
| `FILE_RETENTION_HOURS` | var | `24` | lifetime of download links / R2 objects |
| `HISTORY_RETENTION_DAYS` | var | `30` | job history kept in D1 |
| `RATE_LIMIT_PER_MINUTE` | var | `6` | URL submissions per user per minute |
| `LOG_LEVEL` | var | `info` | `debug` `info` `warn` `error` |
| `TELEGRAM_DELIVERY_MODE` | var | `auto` | `auto` · `bot_api_cloud` · `mtproto` · `bot_api_local` · `r2_link` (operator override of user choice; `mtproto` needs `MTPROTO_ENABLED=true`, `r2_link` needs an R2 binding + `PUBLIC_BASE_URL`) |
| `MEDIA_BACKEND` | var | `container` (free profile: `http`) | `container` = Cloudflare Containers; `http` = self-hosted engine that registers itself (`/internal/engine/register`) |
| `MTPROTO_ENABLED` | var | `false` (free profile: `true`) | offer MTProto delivery (≤ 2 GB); the engine must have `TELEGRAM_API_ID`/`TELEGRAM_API_HASH` |
| `LOCAL_BOT_API_ENABLED`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `LOCAL_BOT_TOKEN` | var/secrets | off | experimental Mode B ([large-file-delivery](large-file-delivery.md)) |
| `INSPECTOR_POOL_SIZE` | var | `2` | shared inspector containers (must be ≤ their `max_instances`) |

Administrators can change `max_concurrent_jobs`, `max_jobs_per_user`, `max_queued_jobs`, `max_duration_seconds`,
`rate_limit_per_minute`, `max_retries` at runtime with `/admin set <key> <value>` (validated ranges, stored in D1,
effective within ~15 s) and undo with `/admin reset <key>`.

## Container sizing *(paid)*

`apps/worker/wrangler.jsonc → containers[]`. Defaults: `MediaJob` = `standard-3` (2 vCPU, 8 GiB, **16 GB disk**), `max_instances: 4`;
`MediaInspector` = `standard-1`, `max_instances: 2`. Rules of thumb:

* disk ≥ 2.5 × the largest output (video + audio parts, merged file, final remux) + the image → 1.9 GB needs ≈ 5–6 GB; 16 GB leaves room.
  For limits above ≈ 5 GB use `standard-4` (20 GB) or a custom type (≤ 20 GB disk).
* CPU is billed only when active; memory and disk are billed for the whole life of an instance, so jobs destroy their container when done.
* Keep `MAX_CONCURRENT_JOBS ≤ containers[MediaJob].max_instances`.
* Large jobs run **one per container**; do not raise `MAX_CONCURRENT_JOBS` until you have watched a few real 1–2 GB jobs.

## Cost controls *(paid; the free profile costs nothing but your own bandwidth, electricity and IP)* (prices as published 2026-10-25 — recheck before relying on them)

Workers Paid $5/month includes 25 GiB-h memory, 375 vCPU-min, 200 GB-h disk; beyond that memory $0.0000025/GiB-s, vCPU $0.00002/s, disk
$0.00000007/GB-s, egress $0.025/GB after 1 TB (NA/EU). Worked example, a 30-minute `standard-3` job at 50 % CPU:
8 GiB × 1800 s × 2.5e-6 = $0.036 + 2 vCPU × 0.5 × 1800 × 2e-5 = $0.036 + 16 GB × 1800 × 7e-8 = $0.002 ≈ **$0.07**, before the included
allotments. Queues (≈3 operations/message), D1 and R2 (free egress) are cents at this scale. Levers: `MAX_OUTPUT_BYTES`,
`MAX_DURATION_SECONDS`, `MAX_CONCURRENT_JOBS`, per-user limits, `max_instances`, destroying containers on completion/cancel.

## Monitoring

* In Telegram: `/admin stats`, `/admin active`, `/admin failed`, `/admin health` (D1, R2, queue depth/oldest age, webhook state and last error,
  container diagnostics: yt-dlp version, free disk, local Bot API status), `/admin limits`, `/admin cleanup`.
* Logs: `npx wrangler tail` (apps/worker). Every line is JSON; job lines carry `jobId` and `correlationId` (also sent to the container, and the
  container's own logs include it). Secrets are redacted.
* Audit: `job_events` in D1 records every state change (`wrangler d1 execute tvd-db --remote --command "select * from job_events where job_id='…'"`).

## Diagnosing a failed download

`/admin failed` lists recent failures with their category. Categories (also shown to the user, in Persian):

| `error_code` | Meaning | Retried? | What to do |
|---|---|---|---|
| `unsupported_site` | no extractor / nothing downloadable | no | update yt-dlp ([updating-dependencies](updating-dependencies.md)); check the URL |
| `private_video`, `login_required`, `geo_restricted`, `drm_protected` | access controls | no | nothing — they are not bypassed |
| `bot_check` | site flagged the data-center IP / wants "not a bot" | no | expected on some sites from Cloudflare IPs; try later or another link |
| `rate_limited`, `network_error`, `timeout` | transient | yes | usually self-heals; check source site |
| `format_unavailable` | the chosen format id vanished or needs re-encoding | no | choose again / allow re-encoding |
| `ffmpeg_failed`, `validation_failed` | processing or output verification failed | ffmpeg: yes · validation: no | inspect container logs by correlation id |
| `too_large`, `too_long` | policy limits | no | adjust limits if intended |
| `upload_failed`, `telegram_error` | Telegram refused / failed | upload: yes · telegram: yes | chat blocked the bot (403) is permanent |
| `container_lost`, `disk_full` | instance restarted / disk too small | yes | consider a bigger instance type |
| `internal` | bug | no | check logs, open an issue |

## Rolling back

* **Worker code:** `npx wrangler deployments list` then `npx wrangler rollback <version-id>` (apps/worker). Deploy Worker-only fixes with
  `npm run deploy:worker` (uses `--containers-rollout none`, so running containers are untouched).
* **Container image:** a container rollout replaces instances (SIGTERM, up to 15 min, then SIGKILL; disks are lost). Jobs on replaced
  instances report `container_lost` and are retried automatically. To roll back, redeploy the previous git revision.
* **Database:** migrations are additive and forward-only. For a bad data change use D1 Time Travel
  (`npx wrangler d1 time-travel restore tvd-db --timestamp <iso>`).
* **Webhook:** `npm run webhook:delete` stops all traffic immediately; `npm run webhook` re-registers it.

## Housekeeping that runs by itself

Every minute (cron): reconcile running jobs, re-queue lost queue messages and overdue retries, fail stale inspections, expire unanswered
menus, delete expired R2 objects and abort abandoned multipart uploads, advance announcements. Hourly: purge history older than
`HISTORY_RETENTION_DAYS` and old rate-limit/update rows. R2 lifecycle rules (created by `npm run provision`) are a second safety net.
