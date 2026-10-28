# Free-plan hybrid profile

Cloudflare **Containers need the Workers Paid plan** (see [`platform-constraints.md`](platform-constraints.md)). If you do not want to pay,
this is the closest valid alternative that keeps every product feature, and it is what the default scripts deploy:

```
 Telegram ──webhook──►  Worker  (Cloudflare FREE plan)           your computer
                         │  D1 (state machine) · Queue (+DLQ) · cron sweeper
                         │                                          ┌──────────────────────────────────┐
                         │   POST /inspect, /jobs, …  (Bearer key)  │ media engine = apps/media-container
                         ├───────────────────────────────────────►  │  FastAPI · policy proxy · yt-dlp   │
                         │      https://<random>.trycloudflare.com  │  FFmpeg/FFprobe · thumbnails       │
                         │            ▲  Cloudflare quick tunnel    │  Telethon (MTProto) uploader       │
                         │            │  (cloudflared.exe)          └───────────┬──────────────────────┘
                         ◄── signed callbacks (progress/state/result) ───────────┤
                         ◄── POST /internal/engine/register (every 30 s) ────────┤
                                                                                 ▼
                                                              Telegram  (files up to ~2 GB, straight from your PC)
```

| Piece | Where | Notes |
|---|---|---|
| Bot UI, webhook, D1 job state machine, Queue, cron sweeper | Worker, Free plan | same code as the paid profile (`wrangler.free.jsonc`) |
| yt-dlp, FFmpeg, thumbnails, verification | **your computer** (`npm run engine`) | same code as the container (`apps/media-container`) |
| Public address of the engine | Cloudflare **quick tunnel** (no account, no domain, free) | the URL changes at every restart; the engine registers the new one itself |
| Upload to Telegram | engine → Telegram | `bot_api_cloud` ≤ 50 000 000 bytes, `mtproto` ≤ 2 000 000 000 bytes (Telethon, bot token + `api_id`/`api_hash`) |
| Download links (R2) | **not available** | no bucket on this profile; the bot never offers it |

## Delivery rules on this profile

* ≤ 50 MB → Bot API (`bot_api_cloud`). 50 MB … `MAX_OUTPUT_BYTES` (1.9 GB) → **MTProto**. Unknown size → starts with the Bot API and **upgrades to
  MTProto** if the finished file is bigger. Nothing above `MAX_OUTPUT_BYTES` is accepted. Files are never split.
* If MTProto is not available (no `api_id`/`api_hash`, or the session failed) a big file is **refused up front** with an explanation; it is never silently degraded.
* **The first message matters.** A bot can only write to users it knows. The engine's Telethon session learns a user when that user's message reaches
  it, so a user must send the bot at least one message **while the engine is running** (the engine keeps its session file in `engine-work/`, so this
  is needed once per user). If the engine has to guess, it falls back to `access_hash=0`; if Telegram still refuses, the job fails with a clear
  `telegram_error` instead of pretending.

## One-time setup

1. Prerequisites: Node ≥ 22, Python ≥ 3.11, FFmpeg + FFprobe on PATH (or installed with `winget install Gyan.FFmpeg --source winget`; `run-engine.mjs` also finds the winget location).
2. `npm install`, then
   `python -m venv .venv && .venv\Scripts\pip install -r apps/media-container/requirements.lock` (Linux/macOS: `.venv/bin/pip`).
3. `cloudflared`: put the official `cloudflared-windows-amd64.exe` in `tools/cloudflared.exe`
   (<https://github.com/cloudflare/cloudflared/releases>; compare its SHA-256 with the one printed in the release notes).
4. `.env` (see `.env.example`): `BOT_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` (from <https://my.telegram.org>),
   plus — only if Telegram/YouTube are blocked where the engine runs — `TELEGRAM_PROXY` and `UPSTREAM_PROXY` (e.g. `socks5h://127.0.0.1:1080`).
5. `npx wrangler login`, then `npm run provision` (D1 + queues; **no R2**) and `npm run deploy` (tests → deploy → `PUBLIC_BASE_URL` → webhook).
   `TELEGRAM_API_ID/HASH` and the local-Bot-API token are **not** uploaded to Cloudflare on this profile — only the engine uses them.
6. Admin id: `node scripts/discover-admin.mjs --write` (the bot must have received a message and no webhook may be set yet), or set `ADMIN_USER_IDS` and run `npm run secrets`.

## Every day

```bash
npm run engine      # starts cloudflared + the engine, registers the tunnel URL with the Worker, restarts either if it dies
```

(On Windows you can also double-click `start-engine.bat` in the project folder.)

* Leave that window open. While it is closed the bot answers *"the download engine is offline"* instead of queueing work nobody will pick up; jobs already
  running are retried (`container_lost`) when the engine comes back, up to `MAX_RETRIES`.
* A fresh heartbeat is required: the Worker only talks to an engine seen in the last **120 s**.
* Ctrl+C de-registers the engine cleanly (`{"url": null}`).
* `--no-tunnel` (with `ENGINE_PUBLIC_URL=https://…` in `.env`) lets you front the engine with your own named tunnel/reverse proxy instead of a quick tunnel;
  `--no-register` runs the engine for local experiments only.

`run-engine.mjs` settings in `.env` (all optional): `ENGINE_PORT` (18080), `ENGINE_WORK_DIR` (`engine-work/`), `ENGINE_MAX_CONCURRENT_JOBS` (2), `ENGINE_NAME`,
`TUNNEL_PROTOCOL` (`auto` | `quic` | `http2`), `UPSTREAM_PROXY`, `TELEGRAM_PROXY`, `COOKIES_FILE`, `MTPROTO_ENABLED`, `LOG_LEVEL`.

## Limits and risks of this profile (read before relying on it)

* **Availability = your computer.** It must be on, awake and online. A quick tunnel has no uptime guarantee and a new URL after every restart (handled automatically,
  but there is a short gap). A named tunnel needs a domain on Cloudflare.
* **Workers Free quotas** (recheck on Cloudflare's *Limits* page): 10 ms CPU per request, 50 subrequests per request, 100 000 requests/day, Queues and D1 free-tier
  allowances. The code keeps handlers short, but a very busy bot can hit them; the symptom would be Worker error 1102/1101 or throttled Queues, not data loss.
* **Bandwidth and IP**: downloads use *your* connection and IP address (that is also why YouTube etc. may work from a home IP and fail from a datacenter).
* **Upstream proxy caveat.** With `UPSTREAM_PROXY` the policy proxy still enforces the hostname and literal-IP rules, but the *proxy* resolves names, so
  the connect-time DNS vetting (layer 3 in [`security.md`](security.md)) cannot see the resolved address. Do not enable it on a machine whose LAN you cannot afford to expose.
* **MTProto session file** (`engine-work/.mtproto-session*`) authenticates the bot — treat it like the bot token (it is git-ignored).
* Port 8080 is often taken by other local tools, so the engine defaults to **18080**.

## Switching to the paid profile later

`wrangler.jsonc` (Containers + R2 + Durable Objects) is unchanged: `npm run provision -- --paid`, `npm run deploy -- --paid`. Both profiles share all Worker and engine code;
only `MEDIA_BACKEND` (`container` | `http`), `MTPROTO_ENABLED` and the presence of an R2 binding differ.
