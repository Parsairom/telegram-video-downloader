# Architecture

> The diagram and flow below describe the **paid (Cloudflare Containers)** profile. The **free profile** keeps the Worker, D1, Queue, cron
> sweeper, state machine and wire contract exactly as described here, but replaces *Durable Object → container* with *Worker → HTTPS → media
> engine on your own computer* (`services/engine.ts` `HttpBackend`, same API as the container), adds engine self-registration
> (`POST /internal/engine/register`, heartbeat 30 s, trusted for 120 s), MTProto delivery from the engine, and has no R2 — see
> [`free-plan-hybrid.md`](free-plan-hybrid.md). `MediaBackend` (`services/container.ts`) is the seam both implement.

```
                       Telegram
                          │  webhook (secret header)            ┌──────────────────────────────────────────────┐
                          ▼                                     │              Cloudflare account              │
 user ──► Worker (control plane, TypeScript) ──────────────────►│  D1   jobs · users · events · limits · stats │
            │  │  │                                             │  R2   delivery links · (staging)             │
            │  │  └─ cron (1/min): sweeper ──────────────────►  │  Queue  tvd-jobs  (+ tvd-jobs-dlq)           │
            │  │                                                └──────────────────────────────────────────────┘
            │  └─ Queue consumer ──► starts jobs, never waits for them
            │                    ▲
            ▼                    │ signed callbacks (progress / state / result / R2 multipart)
   Durable Object (Container class)
     MediaInspector  (pool of 2)  ── /inspect, /frames          no bot token
     MediaJob        (1 per job)  ── /jobs, /jobs/:id, cancel   bot token, downloads, FFmpeg, delivery
            │
            ▼ apps/media-container (Python): policy proxy → yt-dlp subprocess → FFmpeg/FFprobe → Telegram / R2 link
```

The Worker is a **control plane**: it never downloads or transcodes. Everything that takes time happens in a container.

## Request flow

1. **Webhook** — `POST /telegram/webhook`: the secret header is checked in constant time, the update id is claimed in D1
   (`processed_updates`, so Telegram's redeliveries are harmless) and the handler runs. Heavy steps only enqueue messages.
2. **URL intake** — validation + SSRF checks (`security/url.ts`), DNS-over-HTTPS check, per-user rate limit, queue/active limits,
   duplicate detection (normalised URL hash), job row `queued`, status message, Queue message `inspect`.
3. **Inspect** (Queue consumer) — `queued → inspecting`; the container returns real metadata and formats; the Worker builds the
   options (`services/formats.ts`: one per real resolution, advanced list, audio languages) and shows the menu: cover photo,
   title, source, duration, available qualities with sizes and 📤/🔗/🚫 badges. `inspecting → ready`.
4. **Selection** — quality tap (or *Customise*: title, file name, caption, embedded metadata, thumbnail, container, delivery).
   The draft lives in `jobs.selection_json`; ownership of the job is re-checked on every callback. *Start* re-validates size,
   container compatibility and limits, then `ready → queued` and enqueues `download`.
5. **Dispatch** (Queue consumer) — `queued → downloading` using an atomic capacity guard (`UPDATE … WHERE running < max`), then
   `POST /jobs` to the job's container (idempotent by job id) with a per-job HMAC token. The message is **acked immediately**.
6. **Container** — policy proxy → yt-dlp (exact format ids, never a silent fallback) → merge/remux with FFmpeg → FFprobe
   validation → thumbnail → deliver (Telegram `sendVideo/sendDocument/sendAudio`, or R2 multipart link). It reports
   `state`/`progress`/`completed`/`failed` to `/internal/jobs/:id/events` and sends a heartbeat every 20 s.
7. **Completion** — `→ completed`; for link delivery the Worker sends the signed link; the container instance is destroyed.

## State machine

`queued → inspecting → ready → queued → downloading → processing → uploading → completed`, plus `cancelled`, `failed`,
`retry_wait`, `expired`. Every transition is a **compare-and-set** (`UPDATE … WHERE status = :from`) with an audit row in
`job_events` written in the same D1 batch; `packages/shared-types` defines the legal edges and a test pins them.

## Recovery matrix

| Failure | What happens |
|---|---|
| Queue message redelivered | CAS fails → acked without side effects (tests: redelivered inspect/download) |
| Webhook update redelivered | `claimUpdate` returns false → `"duplicate"` |
| Container callback lost | sweeper polls `GET /jobs/:id` every minute and applies the result/failure |
| Container restarted (disk gone) | `GET /jobs/:id` → `unknown` → `failOrRetry(container_lost)` → `retry_wait` → new instance, same job id |
| Container unreachable | grace period of 3 min, then treated as lost |
| Retryable error (network, rate limit, upload, ffmpeg, disk, timeout) | exponential back-off 30 s · 60 s · … ≤10 min, up to `MAX_RETRIES` |
| Permanent error (private, geo, DRM, bot check, unsupported) | `failed` immediately with a precise Persian explanation |
| Queue message exhausts retries | dead-letter consumer fails the job and tells the user |
| User cancels | job → `cancelled` at once; container asked to stop, then destroyed; late events are answered `cancel: true` and ignored |
| Menu never answered | `expired` after 1 h; keyboard removed |
| Orphaned R2 data | `r2_objects` bookkeeping + hourly purge; lifecycle rules as a safety net |
| Telegram upload fails mid-way | the container retries 3× (flood-wait aware); then the job fails/retries as above |

The container never decides alone that a job is lost: only the Worker (D1) is authoritative for job state.

## Why these components

* **One container per job** — isolated disk (a 1.9 GB job cannot starve another), a clean kill switch, and trivial cancellation.
* **Inspector pool** — metadata lookups are short and I/O bound; a small shared pool avoids paying for a cold container per link, and
  it never holds the bot token.
* **Durable Objects** — the Container class *is* a Durable Object; no extra coordinator was added because D1 CAS + the sweeper cover
  coordination.
* **R2** — only for link delivery (and its bookkeeping). Files are streamed to R2 through the Worker's multipart endpoints so the
  container holds no R2 credentials; parts are 32 MiB to stay under the Worker request-body limit.
* **Callbacks, not long-lived requests** — Worker→container calls are short; the container reports back with a signed token, so no
  connection or Queue message is held for the duration of a download.

## Container API (`apps/media-container/app/api.py`)

`GET /health` (open, minimal) · `GET /diagnostics` · `POST /inspect` · `POST /frames` · `POST /jobs` (202, idempotent) ·
`GET /jobs/:id` · `POST /jobs/:id/cancel` · `DELETE /jobs/:id`. All but `/health` require `Authorization: Bearer CONTAINER_API_KEY`.
Wire types are mirrored in `packages/shared-types` and `app/models.py`.

## Data model (D1, `apps/worker/migrations/0001_init.sql`)

`users` (settings JSON, conversation state, block flag) · `jobs` (state, metadata, options, selection, result, attempts,
heartbeat, message ids) · `job_events` (audit) · `processed_updates` · `rate_limits` · `app_config` (runtime limits, maintenance,
announcements) · `daily_stats` · `r2_objects`.
