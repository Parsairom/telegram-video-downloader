# Platform constraints (verified 2026-10-25 against current official documentation)

Everything here comes from the official documentation as published on the date above, not from third-party tutorials.
`UNVERIFIED` means the documentation does not state it and it was not established by experiment — the design does
not depend on those points, and where one matters it is called out under **Open questions**.

Sources use these roots: **CF** = <https://developers.cloudflare.com>, **TG** = <https://core.telegram.org/bots/api>,
**TBA** = <https://github.com/tdlib/telegram-bot-api>, **YT** = <https://github.com/yt-dlp/yt-dlp>.

## 0. Observed on a Workers Free account (real API answers, not documentation)

| Check | Result |
|---|---|
| `wrangler containers list` | `Unauthorized: You do not have access to Cloudflare Containers. Deploying containers requires the Workers Paid plan.` → **on the Free plan Containers cannot be deployed** |
| `wrangler r2 bucket list` | `Please enable R2 through the Cloudflare Dashboard. [code: 10042]` → **R2 has to be enabled in the dashboard first** |
| Local Docker | only needed because the container image is built from a Dockerfile (see §1) |

### 0.1 Consequence: the free hybrid profile

Because Containers need Workers Paid, the default deployment is the free hybrid profile ([`free-plan-hybrid.md`](free-plan-hybrid.md)). Observed on the Free plan
(evidence in [`test-report.md`](test-report.md)): the Worker, **D1**, **Queues** (consumer + dead-letter queue) and the per-minute **cron** trigger are accepted; **R2 stays
disabled** and is not used by that profile. Still `UNVERIFIED` from documentation alone: how the Free-plan limits (10 ms CPU, 50 subrequests, daily request quota) behave under
real traffic — only the traffic described in the test report was exercised.

## 1. Cloudflare Containers *(paid profile only)*

| Item | Fact | Source |
|---|---|---|
| Status / plan | GA (announced 2026-04-13). Requires **Workers Paid** (minimum $5/month). Free plan: not available | CF `/containers/`, `/containers/platform/pricing/`, `/changelog/post/2026-04-13-containers-sandbox-ga/` |
| Instance types | `lite` 1/16 vCPU · 256 MiB · 2 GB disk; `basic` 1/4 vCPU · 1 GiB · 4 GB; `standard-1` 1/2 vCPU · 4 GiB · 8 GB; `standard-2` 1 vCPU · 6 GiB · 12 GB; `standard-3` 2 vCPU · 8 GiB · 16 GB; `standard-4` 4 vCPU · 12 GiB · 20 GB | CF `/containers/platform/limits/` |
| Custom type | 1–4 vCPU, ≤12 GiB memory, ≤20 GB disk, ≥3 GiB memory per vCPU (`default` scheduling policy only) | same |
| Disk | **Ephemeral.** A sleeping/restarted/redeployed instance starts from a fresh disk. No swap; OOM restarts the instance. Image size is capped at the instance disk size | CF `/containers/faq/`, `/containers/concepts/architecture/` |
| Account limits | 6 TiB concurrent memory, 1,500 vCPU, 30 TB disk; 50 GB total image storage | CF limits page |
| Architecture | `linux/amd64`, Firecracker microVM, 1–3 s typical cold start | CF architecture page |
| Building | A **local Docker daemon is required only when `image` is a Dockerfile path**. Alternatives: Workers Builds (git-connected, runs `wrangler deploy`, 20-min build limit), a public `docker.io/...` image, or a registry image | CF `/containers/guides/deploy/`, `/workers/ci-cd/builds/limits-and-pricing/` |
| Lifecycle | `Container` class: `sleepAfter` default `10m`; `renewActivityTimeout()`; stop = SIGTERM then up to 15 min then SIGKILL (same for rollouts). No documented maximum runtime; host restarts happen irregularly | CF `/containers/api/container-class/` |
| Reachability | A container is reachable **only through its Durable Object**; end users cannot open TCP/UDP to it | CF architecture page |
| Egress | Internet egress on by default (`enableInternet = true`). Private/RFC-1918 reachability **UNVERIFIED** | CF `/containers/configuration/outbound-traffic/` |
| Bindings | No native bindings inside a container; outbound handlers in the DO can expose bindings over HTTP. Container↔container networking and shared filesystem: not documented | CF `/containers/configuration/workers-connections/` |
| Pricing | Billed per 10 ms while running. Memory $0.0000025/GiB-s and disk $0.00000007/GB-s on **provisioned** size (even idle); CPU $0.00002/vCPU-s on **active** use. Included/month: 25 GiB-h memory, 375 vCPU-min, 200 GB-h disk. Egress (NA/EU) $0.025/GB after 1 TB | CF `/containers/platform/pricing/` |
| Wrangler schema | `containers: [{ class_name, image, image_build_context, instance_type, max_instances }]` + a Durable Object binding and `migrations`/`exports` for the class | CF `/containers/configuration/wrangler/` |

**What this project uses:** `MediaJob` (one instance per download job) on `standard-3` (2 vCPU, 8 GiB, **16 GB disk**) and
`MediaInspector` (small shared pool for metadata and frame previews) on `standard-1`. A 1.9 GB source can briefly need
≈2.3× its size on disk (video + audio parts, merged file, final remux), i.e. ≈4.4 GB, plus the image — comfortably inside
16 GB. `standard-4` (20 GB) is the next step if larger limits are configured. Both are in `apps/worker/wrangler.jsonc`.

## 2. Queues

At-least-once delivery (handlers must be idempotent) · message ≤128 KB · `max_retries` default 3 (limit 100) · **no automatic
back-off** (use `retry({delaySeconds})`, ≤24 h) · dead-letter queue via `dead_letter_queue` (without one, messages are deleted
after the retries) · `max_batch_size` ≤100 · consumer wall time **15 min** · retention 24 h (Free) / 14 days (Paid) ·
$0.40 per million operations after 1 M/month (CF `/queues/platform/limits/`, `/queues/configuration/batching-retries/`,
`/queues/configuration/dead-letter-queues/`, `/queues/platform/pricing/`).

**Consequence:** a 30-minute download cannot be awaited inside a consumer. Messages only *start* work; the container runs the
job and reports back (see [architecture](architecture.md)).

## 3. D1, R2, Durable Objects, Workers

* **D1** — 10 GB per database (Paid), 100 bound parameters per query, 30 s per query, 1,000 queries per invocation (Paid);
  `db.batch()` is atomic (rolls back the whole sequence). Migrations: `wrangler d1 migrations apply`
  (CF `/d1/platform/limits/`, `/d1/worker-api/d1-database/`).
* **R2** — multipart parts 5 MiB–5 GiB, ≤10,000 parts, ≤5 TiB per object; lifecycle rules for expiry and aborting incomplete
  uploads; binding API `createMultipartUpload/uploadPart/complete/abort`; presigned URLs only on the S3 domain; free egress.
  **Needs enabling in the dashboard** (CF `/r2/get-started/`); whether a payment method is required for the free tier is
  UNVERIFIED (CF `/r2/objects/multipart-objects/`, `/r2/buckets/object-lifecycles/`, `/r2/pricing/`).
* **Durable Objects** — SQLite-backed classes work on Free and Paid; alarms retried with back-off; wall time 15 min
  (CF `/durable-objects/platform/limits/`).
* **Workers** — HTTP wall time unlimited while the client is connected; queue/cron/alarm invocations 15 min; CPU default 30 s
  (≤5 min); **request body ≤100 MB on Free/Pro** (so R2 parts are 32 MiB); `waitUntil` ≤30 s after the response; cron triggers
  need ≤15 min propagation; 10,000 subrequests (Paid). `compatibility_date` ≥ 2026-08-04 enables `nodejs_compat` by default
  (CF `/workers/platform/limits/`, `/workers/configuration/cron-triggers/`).
* **Wrangler** 4.152.0 (Node ≥22). Containers need Docker only for Dockerfile images. `wrangler deploy --secrets-file` uploads
  secrets together with the code; `wrangler login` (OAuth) or `CLOUDFLARE_API_TOKEN`.

## 4. Telegram Bot API (cloud) — Bot API 10.3

| Item | Fact | Source |
|---|---|---|
| Upload via multipart | photos 10 MB, **other files 50 MB** (sendVideo / sendDocument / sendAudio) | TG `#sending-files` |
| Send by URL | photos 5 MB, other content 20 MB | same |
| Download (`getFile`) | 20 MB | TG `#getfile` |
| Thumbnail | JPEG, **< 200 kB, ≤ 320 px per side**; **ignored unless uploaded with multipart/form-data**; `attach://<name>` | TG `#sendvideo` |
| Captions / text | caption ≤1024 chars after parsing; message ≤4096 | TG |
| `callback_data` | 1–64 **bytes** | TG `#inlinekeyboardbutton` |
| Webhook | HTTPS only; the `secret_token` is echoed in the header **`X-Telegram-Bot-Api-Secret-Token`**; ports 443/80/88/8443, TLS ≥1.2, IPv4 only; retries on non-2xx "a reasonable number of times" | TG `#setwebhook`, `core.telegram.org/bots/webhooks` |
| Rate limits | ~1 msg/s per chat, ≤20/min per group, ~30/s broadcast; 429 carries `retry_after`; edit-specific limits UNVERIFIED | TG FAQ |
| `logOut` | needed before running a bot on a local server; you cannot return to the cloud server for **10 minutes** | TG `#logout` |

## 5. Local Bot API server (`tdlib/telegram-bot-api`, `--local`)

* Uploads up to **2000 MB** (units — MB vs MiB — UNVERIFIED), downloads unlimited, `file://` local paths for uploads. Webhooks may be
  plain HTTP. Mandatory arguments: **`--api-id` and `--api-hash`** from my.telegram.org (env `TELEGRAM_API_ID/HASH` also work).
* **No official Docker image and no releases** — build from `master` (needs OpenSSL, zlib, gperf, CMake 3.10+, a C++17 compiler;
  "requires a lot of memory"; build time UNVERIFIED). Third-party images exist but are unaudited.
* Its HTTP server has a hard-coded **500 s idle timeout**: a 1.9 GB upload needs ≥ ~3.8 MB/s or the HTTP response is never sent
  (the file is still delivered). State lives under `--dir`; `logOut` deletes it; its storage GC can delete downloaded files.
* Community reports (not official) say mixing cloud and local API for one bot loses or duplicates updates.

### Potential obstacles to running it inside a Cloudflare Container

1. **No persistent disk** — the server's state directory is lost on every sleep/rollout/restart.
2. **Not reachable except through the Durable Object**; a webhook *receiver* would have to live in an instance that can sleep.
3. **No documented shared filesystem between containers**, so `file://` uploads only work when the server runs in the same
   container as the media processor (which is how this project wires it).
4. **API credentials are required** (`API_ID`/`API_HASH`, obtained at <https://my.telegram.org>); a bot token alone is not enough.
5. The `logOut` / 10-minute rule and the mixing warning make *one bot with both cloud updates and a local sender* risky.
6. Build needs Docker/CI and substantial RAM.

All six are documented in [large-file-delivery](large-file-delivery.md) together with the experiments that would settle them.

## 6. yt-dlp and FFmpeg

* yt-dlp **2026.10.21** (Python ≥3.10). A **JavaScript runtime is required for full YouTube support** (`yt-dlp-ejs` + deno
  *or node ≥ 22*); the image ships Node 22. `enable_file_urls` is off by default. yt-dlp has no official SSRF guidance — this
  project enforces its own egress policy (see [security](security.md)).
* The maintainers state that data-center IPs are susceptible to being blocked ("We cannot help with this") and that PO tokens /
  cookies are needed in some cases. **Bot checks are not bypassed**; such failures are classified as `bot_check`.
* `--max-filesize` is only enforced for plain HTTP downloads with a known length, so the container also watches the work
  directory and aborts oversized DASH/HLS downloads.
* FFmpeg: stable 9.0.2 / 8.1.3 upstream; the image uses the distribution's package (Debian 13). `-c copy -movflags +faststart`
  for remux; thumbnails via `scale=320:320:force_original_aspect_ratio=decrease`; probing via
  `ffprobe -print_format json -show_streams -show_format`.

## Open questions (not decided by the documentation)

| Question | Why it matters | How to settle it |
|---|---|---|
| Can a container reach private IPs / the host metadata service? | residual SSRF risk if a yt-dlp extractor ignores the proxy settings | run `curl` against `169.254.169.254` from `wrangler containers ssh` |
| Does R2's free tier need a card? | account set-up | dashboard R2 page |
| Max body/duration of the Worker→container hop | uploads of big job requests (small here) | none needed: only small JSON crosses it |
| Does the local Bot API server survive sleep/rollout on Containers? | Mode B viability | the experiments in `docs/large-file-delivery.md` |
