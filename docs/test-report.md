# Test and verification report

Results of the runs performed on 2026-10-25 (Windows 11, Node 24, Python 3.14, wrangler 4.152.0, vitest 4.1.12, pytest 9.1.1, FFmpeg/FFprobe 9.0.2, yt-dlp 2026.10.21,
cloudflared 2026.10.3). Passed, failed, skipped and not-run items are listed separately; nothing is claimed beyond what was executed.
The deployment that was exercised is the **free hybrid profile** ([`free-plan-hybrid.md`](free-plan-hybrid.md)).

## A. Automated tests

| Suite | Command | Result |
|---|---|---|
| TypeScript typecheck (strict, Worker and tests) | `npm run typecheck` | clean |
| ESLint (Worker, tests, shared types, scripts) | `npm run lint` | clean |
| Worker tests — inside the Workers runtime (workerd/miniflare) with real D1 migrations and R2 emulation | `npm test` | **215 passed / 0 failed** (9 files) |
| Python lint | `ruff check apps/media-container` | clean |
| Media-engine tests, including everything that needs real FFmpeg/FFprobe/yt-dlp | `npm run test:container` (FFmpeg on `PATH`, `TVD_NO_AUTOAPP=1`) | **133 passed / 0 failed / 1 skipped** (the opt-in real-site test) |
| Dependency audit (npm production dependencies) | `npm audit --omit=dev` | 0 vulnerabilities |

Coverage, against real binaries and local fixtures (not real Telegram): direct MP4 and HLS (separate audio/video, merged) download → FFmpeg remux → FFprobe validation → Telegram-valid
thumbnail → multipart upload to a fake Telegram server → signed callbacks → cleanup; exact-format enforcement; failure classification; cancellation; R2 link delivery on the
emulator; SSRF controls (URL validation, connect-time policy proxy, proxy chaining); engine API authentication; the MTProto sender (fake Telethon: attributes, thumbnail,
FloodWait retry, peer fallback, error mapping); engine registration (auth, URL policy, de-registration); the HTTP backend (freshness, verbs, error mapping, stale engine never
contacted); the size policy with MTProto and without R2; settings and delivery keyboards; replies to deleted messages; a missing R2 bucket.

## B. Live verification (Cloudflare Workers Free account, real bot, real Telegram)

| What | Evidence |
|---|---|
| The Free plan accepts the Worker, **D1** (9 tables after remote migrations), **Queues** (`tvd-jobs` with a dead-letter queue, consumers attached) and the per-minute **cron** trigger | `wrangler d1 execute … sqlite_master`, `wrangler queues list/info`, `wrangler tail` showing `cron` and `queue` events with outcome `ok` |
| `/health` returns `{"ok":true}`; a webhook call without the secret returns 401; an engine registration without the key returns 401 | curl |
| The Telegram webhook is registered; `getWebhookInfo` reports no pending updates and no error | `npm run webhook` output |
| The engine started a Cloudflare quick tunnel, registered itself (`app_config.engine` in remote D1) and heartbeats every 30 s with HTTP 200 | D1 row, engine log |
| The Telethon session logged in as the bot through a SOCKS proxy | engine log |
| Queue → tunnel → engine: the Queue consumer ran and the engine received `/inspect` through the tunnel | `wrangler tail`, engine log |
| **Test A — 30.7 MB direct MP4** (1080p H.264, 10 s): inspect → menu photo → quality button → download through a proxy → FFmpeg/FFprobe validation → **Bot API upload** → job `completed` (1920×1080, 10 s, 30 704 529 B, SHA-256 recorded) | D1 `jobs.result_json` |
| **Test B — YouTube 360p, delivery mode `mtproto`** (size estimate 65 MB, real file 22.5 MB): yt-dlp through a proxy (HLS video+audio merged) → **MTProto upload** → `completed` (640×360, 634.6 s) | D1 `jobs.result_json` |
| **Test C — YouTube 720p, a real file above the 50 MB Bot API limit**: download at 0.8–0.9 MB/s → **MTProto upload of 154 727 255 bytes (154.7 MB)** → `completed` (1280×720, 634.6 s, SHA-256 recorded); the upload took about 20 minutes at ≈ 0.1 MB/s | D1 `jobs.result_json`, progress samples |

What this evidence does **not** show:

* The runs were driven by synthetic Telegram updates (signed with the real webhook secret) for one account, because a person cannot be automated here. Worker, D1, Queue, tunnel,
  engine, yt-dlp, FFmpeg and the Telegram upload were all real; the Telegram client UI was not inspected, so the *appearance* of menus, covers and captions is not verified by a person.
* Size estimates for HLS sources are upper bounds (Test B: estimated 65 MB, real 22 MB), so a file can be sent over MTProto when the Bot API would have sufficed. That is harmless,
  but the sizes shown in the menu for HLS sources are indicative only (`≈` is displayed).
* Upload speed in these runs was limited by the SOCKS proxy that was used (≈ 0.1–0.2 MB/s). **A 1.9 GB upload would take hours on that link and was not attempted.**

## C. Defects found by the live runs (all fixed, each with a regression test)

| Defect | Fix |
|---|---|
| The Worker rejected the engine's `completed` event with `mode: "mtproto"` (the event schema listed only the three older modes), so every MTProto job would have hung | schema derives from `DELIVERY_MODES`; a test completes a job through the real route |
| A reply to a user message that had been deleted meanwhile (`message to be replied not found`) aborted URL intake and left the job in `queued` with no queue message for 10 minutes | `Telegram.call` and the album upload retry without the reply target; the status message is best-effort, so the job is always queued |
| `httpx` with a SOCKS proxy (`socks5h://…`) raised `ImportError` (the `socksio` extra) — the Bot API upload and cover fetch crashed after a successful download | `httpx[socks]` in the dependencies and the lock file; a test constructs SOCKS clients |
| FFprobe/FFmpeg could not read any **https** source behind the policy proxy (`Protocol 'httpproxy' not on whitelist`), so direct-media inspection lost resolution/duration and frame previews would have failed | `httpproxy` added to the protocol whitelist (still no `file`, `ftp`, …); a test asserts the command line |
| `requirements.lock` contained 14 packages (the generator's regex stopped at `yt-dlp[default]`) — the container image would have lacked yt-dlp | parser rewritten and sanity-checked; the lock has 34 packages |
| The scripts broke on a repository path containing a space | arguments are quoted for `cmd.exe`; the config path is relative |
| Telethon used pure-Python AES (no libssl) | `cryptg` pinned |

## D. Large files over MTProto

Verified: a **154.7 MB** file (three times the Bot API limit) was delivered by the bot account over MTProto, with the expected size, dimensions and duration in the result.
**Not verified:** anything near the 1.9 GB ceiling (disk and memory behaviour, Telegram's part limit, a dropped connection mid-upload, FloodWait during a long upload). The engine retries a
failed upload up to three times from the beginning; uploads do not resume across engine restarts.

## E. Not run / unverified

| Item | Reason |
|---|---|
| Paid profile on Cloudflare (Containers, R2, Durable Objects) | requires Workers Paid and R2; the Containers code has never been deployed |
| Container image build | no Docker daemon was available |
| Local Telegram Bot API server (Mode B) | blocked, see [`large-file-delivery.md`](large-file-delivery.md) |
| 1–2 GB uploads, mid-upload failure and recovery | not attempted (hours at the available upload speed) |
| A person using the bot (menu appearance, `/settings`, `/history`, customisation screens, thumbnail upload) | only synthetic updates were sent; those flows are covered by automated tests |
| Workers Free quotas under load (10 ms CPU, 50 subrequests, daily requests) | only light traffic; no 1101/1102 errors were observed |
| Long-running reliability: sleep/wake of the host, quick-tunnel restarts during a job | one engine restart between jobs re-registered correctly; restarts during a job were not tested live |
| Load and soak tests | not attempted |
| Real websites other than YouTube and a direct-MP4 host | the opt-in `tests/test_network_extractors.py` was not run |

## Environment notes

* `winget install Cloudflare.cloudflared` was cancelled at the UAC prompt; the official portable `cloudflared.exe` was used instead after its SHA-256 matched both the GitHub release
  digest and the release notes.
* The connection to Cloudflare was intermittently slow during the runs (a few connect timeouts); the engine heartbeat and the cron sweeper absorb this.
