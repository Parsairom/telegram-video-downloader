# Large files and delivery modes

**Never assume the standard Bot API takes large files.** It does not: a bot may upload at most **50 MB** per file through
`api.telegram.org` (TG `#sending-files`). This project therefore has four delivery modes and a policy that picks one *before*
any bytes are downloaded.

| Mode | `deliveryMode` | Limit | Status |
|---|---|---|---|
| **A** Cloud Bot API (`sendVideo` / `sendDocument` / `sendAudio`) | `bot_api_cloud` | **50 000 000 bytes** (constant `TELEGRAM_CLOUD_UPLOAD_LIMIT_BYTES`, a conservative reading of "50 MB") | implemented; container tests use a **local fake Telegram server**; real-Telegram evidence (if any) is in `docs/test-report.md` |
| **D** MTProto upload by the bot (Telethon, bot token + `api_id`/`api_hash`) | `mtproto` | **2 000 000 000 bytes** (`TELEGRAM_MTPROTO_UPLOAD_LIMIT_BYTES`; the application ceiling `MAX_OUTPUT_BYTES` 1.9 GB applies first) | implemented in the engine (`app/mtproto.py`); the free profile's large-file path — real-Telegram evidence in `docs/test-report.md` |
| **B** Local Bot API server inside the job container | `bot_api_local` | 2 000 000 000 bytes | implemented, **UNVERIFIED and currently blocked** (see below) |
| **C** Signed, expiring download link (R2 multipart through the Worker) | `r2_link` | `MAX_OUTPUT_BYTES` (default **1 900 000 000**) | paid profile only (needs an R2 binding + `PUBLIC_BASE_URL`); tested against R2 emulation; delivered as a *message with a link*, not a Telegram file |

R2 capacity must not be confused with Telegram capacity: Mode C can carry the 1.9 GB file, but the user downloads it over HTTPS.
Files are **never split** into chunks.

## Mode D — MTProto (why it replaced the local Bot API server for large files)

A bot account may upload up to 2 GB through MTProto exactly like a user account can, with no extra server binary. It needs `api_id`/`api_hash`
(from <https://my.telegram.org>) in the **engine's** environment; the Worker only learns whether it is on (`MTPROTO_ENABLED`, advertised by the engine's registration).
Unlike Mode B it does not require `logOut` from the cloud Bot API, so the webhook keeps working and updates cannot be lost.
Caveats: the Telethon session must have *seen* the user (it persists in `engine-work/`, so one message from each user is enough — otherwise the engine tries
`access_hash=0` and fails with a clear `telegram_error` if Telegram refuses); `cryptg` is installed so AES is native (pure-Python AES is far too slow for GB-sized uploads);
FloodWait is honoured with retries; uploads can use `TELEGRAM_PROXY` (SOCKS5/HTTP) when Telegram is blocked locally.

## Size policy (`apps/worker/src/services/size-policy.ts`, bytes only)

Before download: use the extractor's size (exact or estimated; estimates get a 10 % margin). After download: measure the real
file, validate it with FFprobe, and compare against the selected mode's limit.

| Situation | Result |
|---|---|
| estimate > `MAX_OUTPUT_BYTES` | option shown with 🚫, refused with an alert; nothing starts |
| `auto`, size ≤ 50 MB | direct upload (Mode A), with fallback armed |
| `auto`, 50 MB < size ≤ 2000 MB, MTProto enabled | Mode D |
| `auto`, 50 MB < size, local mode enabled and ≤ 2000 MB (MTProto off) | Mode B |
| `auto`, otherwise, R2 link delivery available | Mode C |
| `auto`, otherwise (free profile without MTProto) | refused up front (`exceeds_mode`) — never silently degraded |
| `auto`, size unknown | Mode A **with fallback**: if the finished file turns out too big, the engine upgrades to MTProto (or, when available, a link) instead of failing |
| explicit "direct Telegram" for a file Telegram cannot carry | refused — no upload that is predestined to fail |
| output file larger than the ceiling after download | job fails with `too_large`; nothing is sent |

Quality is **never** changed silently: if the chosen format id disappeared the job fails with `format_unavailable`.

## Mode B — local Telegram Bot API server: what is built and what is blocked

Built: `apps/media-container/Dockerfile` has an optional build stage (`--build-arg WITH_LOCAL_BOT_API=1`) that compiles
`tdlib/telegram-bot-api`; `app/bot_api.py` starts it with `--local` on `127.0.0.1:8081` inside the job container; uploads use
`file:///work/<job>/<file>` so the 1.9 GB file is read from disk by the server (the media processor and the server share one
filesystem because they run in the same container); `GET /diagnostics` reports availability.

Not verified. The ten open questions and their present status:

| # | Question | Status |
|---|---|---|
| 1 | Does it build and start in a Cloudflare Container? | **not tried** — needs Docker, the Workers Paid plan and API credentials |
| 2 | Are its dependencies available for the runtime/architecture? | apt packages exist for Debian 13 / amd64 (documented), not built |
| 3 | Can the media processor talk to it reliably? | designed for `127.0.0.1` in the same container; untested |
| 4 | Are local paths / temp storage accessible? | same container ⇒ yes by construction; untested |
| 5 | TLS/networking | server speaks plain HTTP on loopback only; nothing external needed |
| 6 | Can it stay available with the required lifecycle? | **doubtful**: per-job instances sleep/restart and have no persistent disk |
| 7 | Can the Worker coordinate and receive accurate results? | results come from the media processor's own call (message id), not the server |
| 8 | Failure recovery | job-level retry exists; server state loss on restart is the open issue |
| 9 | Upload near the limit | **not tried**; upstream says >2000 MB fails (`FILE_PARTS_INVALID`) and the server's 500 s idle timeout can swallow the HTTP response of a slow upload |
| 10 | Compliance with Cloudflare requirements | no violation known; container egress/billing documented in `platform-constraints.md` |

### Blockers that remain

1. **`API_ID` / `API_HASH` are mandatory** for the server (a bot token alone is not enough). Without them Mode B cannot start
   (`LocalBotApi.unavailable_reason()` says so; the Worker never offers Mode B unless `LOCAL_BOT_API_ENABLED=true` *and* both values are set).
2. **One bot cannot sensibly use both servers.** `logOut` on the cloud server is required first and forbids returning for ten
   minutes; community reports warn of lost/duplicated updates when mixing. This project keeps the **webhook on the cloud API**
   (the Worker needs it) and would use the local server only for *sending* — which is exactly the mixed setup that has not been proven.
   The documented escape hatch is a **second, delivery-only bot** (`LOCAL_BOT_TOKEN`): no updates flow through it, so nothing can be
   lost; the user must press *Start* on that bot once, otherwise Telegram answers `chat not found`.
3. **No persistent disk** for the server's state directory in a container.
4. **No official image**; the build is long and memory-hungry.

Decision: Mode B stays **disabled by default**; large files use MTProto (Mode D) or, on the paid profile, links (Mode C). If you want to pursue Mode B: obtain API credentials, enable the Workers Paid plan, build with
`WITH_LOCAL_BOT_API=1`, set `LOCAL_BOT_API_ENABLED=true`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, preferably `LOCAL_BOT_TOKEN`
(a separate bot), then run experiments 1, 3, 4, 8 and 9 with a synthetic 1.9 GB file (`ffmpeg -f lavfi -i testsrc … -b:v` sized
to the limit) and record the outcome here.
