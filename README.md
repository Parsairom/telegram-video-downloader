<div align="center">

# Telegram Video Downloader

**Send a link. Pick a real quality. Get a verified video in Telegram — up to ~2 GB.**

A Telegram bot that downloads video and audio from thousands of sites, shows only the qualities a source really offers,
lets you customise cover, title, file name and caption, and delivers the checked file straight into the chat.

[English](README.md) · [فارسی](README.fa.md)

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node.js ≥ 22](https://img.shields.io/badge/node-%E2%89%A5%2022-339933?logo=node.js&logoColor=white)
![Python ≥ 3.11](https://img.shields.io/badge/python-%E2%89%A5%203.11-3776AB?logo=python&logoColor=white)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)

</div>

---

## Highlights

- **Paste a link, nothing else.** The bot accepts a URL directly (YouTube and the 1000+ sites supported by [yt-dlp](https://github.com/yt-dlp/yt-dlp), plus direct MP4/WebM/HLS/DASH links).
- **Only real qualities.** One button per resolution the source actually has, with estimated or exact size and a badge showing how the file will be delivered. An advanced menu lists every format (codec, fps, HDR, container) and audio languages; audio-only MP3 is one tap away.
- **Big files.** Up to 50 MB through the Bot API, up to ~2 GB through MTProto (Telethon) — no file splitting, no third-party hosting.
- **Customise everything.** Cover (original, a frame from the video, a preview of several frames, your own picture, or none), title, file name, caption and embedded metadata are four independent settings.
- **Verified output.** Every file is probed with FFprobe (container, streams, duration, resolution) before it is sent. Quality is never changed silently: if the chosen format disappears the job fails with a clear reason.
- **Persian and English interface**, live progress (percent, speed, ETA, phase), cancel at any time, per-user settings and history.
- **Built to recover.** Compare-and-set state machine in D1, a Queue with a dead-letter queue, a per-minute sweeper, idempotent webhook handling — lost callbacks, redelivered messages and restarts do not duplicate or lose work.
- **Security first.** SSRF protection in four layers, per-job signed callbacks, constant-time secret checks, redacted logs, rate limits and quotas. See [`docs/security.md`](docs/security.md).

## How it works

```
 Telegram ──webhook──►  Cloudflare Worker  (bot UI, state machine, queue, cron sweeper)
                          │  D1 · Queues
                          │            ▲  signed progress / result callbacks
                          ▼            │
                     Media engine ─────┘   yt-dlp → FFmpeg/FFprobe → thumbnails → upload
                     (Python, FastAPI)                         │
                                                               ▼
                                                  Telegram (Bot API ≤ 50 MB · MTProto ≤ ~2 GB)
```

The Worker is a control plane: it never downloads or transcodes anything. The media engine does the heavy work and reports back with signed callbacks.
It is the same code in two deployment profiles:

| Profile | Worker | Media engine | Large files | Needs |
|---|---|---|---|---|
| **Free** *(default scripts)* | Cloudflare Workers **Free** | on **your computer**, exposed through a free Cloudflare quick tunnel | MTProto, up to ~2 GB | Telegram `api_id`/`api_hash`, `cloudflared`, FFmpeg — see [`docs/free-plan-hybrid.md`](docs/free-plan-hybrid.md) |
| **Paid** *(`--paid`)* | Workers Paid | **Cloudflare Containers**, one per job | MTProto and/or R2 download links | Workers Paid, R2, Docker or Workers Builds |

## Delivery modes

| Mode | Limit | Notes |
|---|---|---|
| Bot API (`bot_api_cloud`) | 50 000 000 bytes | used automatically for small files |
| **MTProto** (`mtproto`) | 2 000 000 000 bytes (ceiling configurable, default 1.9 GB) | the bot account uploads through Telethon; needs `api_id`/`api_hash` on the engine |
| R2 link (`r2_link`) | `MAX_OUTPUT_BYTES` | paid profile only: signed, expiring download link |
| Local Bot API server (`bot_api_local`) | 2 000 000 000 bytes | experimental, disabled by default — see [`docs/large-file-delivery.md`](docs/large-file-delivery.md) |

In `auto` mode the smallest mechanism that can carry the file is chosen *before* anything is downloaded; a file that cannot be delivered is refused up front instead of failing at the end.

## Quick start (free profile)

**Prerequisites:** Node.js ≥ 22, Python ≥ 3.11, FFmpeg + FFprobe on `PATH`, a Cloudflare account (Free plan), a bot token from [@BotFather](https://t.me/BotFather), and an `api_id`/`api_hash` pair from <https://my.telegram.org>
(only needed for files above 50 MB). Put the official [`cloudflared`](https://github.com/cloudflare/cloudflared/releases) binary in `tools/` (`tools/cloudflared.exe` on Windows).

```bash
git clone https://github.com/Parsairom/telegram-video-downloader.git
cd telegram-video-downloader

npm install
python -m venv .venv
.venv/bin/pip install -r apps/media-container/requirements.lock      # Windows: .venv\Scripts\pip

cp .env.example .env              # fill BOT_TOKEN, CLOUDFLARE_ACCOUNT_ID, TELEGRAM_API_ID, TELEGRAM_API_HASH
npx wrangler login                # once

npm run provision                 # creates the D1 database and Queues, applies migrations
node scripts/discover-admin.mjs --write   # optional: send any message to your bot first; stores your Telegram id as admin
npm run deploy                    # tests → deploy → sets PUBLIC_BASE_URL → registers the Telegram webhook
npm run engine                    # starts the tunnel + media engine; keep this running
```

Open your bot in Telegram, send `/start`, then paste a link. Every user needs to message the bot once while the engine is running so large files can be delivered over MTProto.
Day-to-day operation, troubleshooting and the limits of the free profile are covered in [`docs/free-plan-hybrid.md`](docs/free-plan-hybrid.md) and [`docs/operations.md`](docs/operations.md).

**Bot commands:** `/start` `/help` `/settings` `/history` `/cancel` `/privacy`; admins also get `/admin` (stats, active and failed jobs, health, limits, user blocking, broadcast).

## Configuration

Secrets live in `.env` (git-ignored) and are uploaded by `npm run deploy`; tunables are `vars` in `apps/worker/wrangler.free.jsonc` (or `wrangler.jsonc` for the paid profile).
`npm run provision` writes your resource ids into a git-ignored `wrangler.*.local.jsonc`, so the tracked templates never contain account-specific values.

| Variable | Default | Meaning |
|---|---|---|
| `MAX_OUTPUT_BYTES` | `1900000000` | ceiling per output file, in bytes |
| `MAX_CONCURRENT_JOBS` / `MAX_JOBS_PER_USER` | `2` / `2` | global and per-user concurrency |
| `TELEGRAM_DELIVERY_MODE` | `auto` | `auto`, `bot_api_cloud`, `mtproto`, `r2_link`, `bot_api_local` |
| `RATE_LIMIT_PER_MINUTE` | `6` | URL submissions per user per minute |
| `UPSTREAM_PROXY`, `TELEGRAM_PROXY` | – | proxies for the engine when sites or Telegram are blocked on its network |

The complete reference is in [`docs/operations.md`](docs/operations.md).

## Repository layout

```
apps/worker/            Cloudflare Worker (TypeScript): webhook, bot UI, D1, Queues, engine/container control, cron sweeper
  migrations/           D1 schema
  wrangler.free.jsonc   free profile template        wrangler.jsonc   paid profile template
apps/media-container/   Python media engine: policy proxy, yt-dlp, FFmpeg, thumbnails, Bot API + MTProto delivery (+ Dockerfile, tests)
packages/shared-types/  state machine, error codes and the Worker ↔ engine wire contract
scripts/                provision · secrets · deploy · webhook · discover-admin · run-engine · lock-deps
docs/                   architecture, security, operations, large files, free profile, adapters, dependency updates, test report
```

## Development

```bash
.venv/bin/pip install pytest pytest-asyncio python-multipart ruff     # test tooling (Windows: .venv\Scripts\pip), then activate the venv

npm run test:all          # typecheck + lint + Worker tests (workerd, real D1 migrations) + engine tests
npm test                  # Worker tests only
npm run test:container    # engine tests — set TVD_NO_AUTOAPP=1 and have ffmpeg/ffprobe on PATH
```

What has and has not been verified, with evidence, is recorded in [`docs/test-report.md`](docs/test-report.md).

## Supported sites and limits

Site support is exactly as good as yt-dlp's extractor for that site on that day; when a source cannot be processed the bot says why (unsupported, private, login required, geo-restricted, DRM, rate-limited, bot check, unavailable).
Some sites block data-centre IP addresses — another reason the free profile, which uses your own connection, can work where a cloud container cannot. Live streams and DRM-protected media are not supported, and the bot does **not**
try to bypass logins, CAPTCHAs or bot checks. To add site-specific behaviour see [`docs/adding-adapters.md`](docs/adding-adapters.md); to update yt-dlp safely see [`docs/updating-dependencies.md`](docs/updating-dependencies.md).

Known limitations of the free profile: the bot is only available while your computer is on and `npm run engine` is running; quick-tunnel URLs change on every restart (the engine re-registers automatically) and carry no uptime guarantee;
Workers Free quotas apply. The Containers profile is implemented and tested but has not been run on Cloudflare Containers.

## Documentation

| | |
|---|---|
| [`docs/free-plan-hybrid.md`](docs/free-plan-hybrid.md) | free profile: setup, daily use, limits |
| [`docs/architecture.md`](docs/architecture.md) | components, request flow, state machine, recovery |
| [`docs/security.md`](docs/security.md) | threat model and SSRF layers |
| [`docs/operations.md`](docs/operations.md) | configuration, monitoring, troubleshooting, rollback |
| [`docs/large-file-delivery.md`](docs/large-file-delivery.md) | delivery modes and the size policy |
| [`docs/platform-constraints.md`](docs/platform-constraints.md) | Cloudflare, Telegram and yt-dlp facts the design relies on |
| [`docs/test-report.md`](docs/test-report.md) | what was tested, how, and what was not |

## Responsible use

Download only content you are allowed to download. The bot does not bypass DRM, paywalls or access controls, keeps no media after delivery by default, and the operator is responsible for how a deployment is used.

## License

[MIT](LICENSE). Third-party components keep their own licenses (yt-dlp: Unlicense; FFmpeg: LGPL/GPL depending on the build; Telethon: MIT; telegram-bot-api: BSL-1.0).
