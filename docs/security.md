# Security model

## Assets and threats

| Asset | Threat | Control |
|---|---|---|
| Bot token, signing secrets | leak via logs, containers, source | secrets only in Cloudflare secrets / local `.env` (gitignored, mode 600); structured logs redact tokens, bearer tokens and signed-URL parameters (`log.ts`, tested); yt-dlp/FFmpeg run with a **scrubbed environment**; inspector containers never receive the bot token; containers get a **per-job token**, never the master signing secret |
| Internal network (container host, metadata service, private ranges) | SSRF through a submitted URL, a redirect, DNS rebinding, or an extractor's secondary request | see below |
| Webhook endpoint | forged updates | `X-Telegram-Bot-Api-Secret-Token` compared in constant time; body ≤1 MB; update-id claim makes handling idempotent |
| Container API | unauthenticated access | reachable only through its Durable Object; additionally `Authorization: Bearer CONTAINER_API_KEY`; only `/health` is open and returns `{ok:true}` |
| Callback endpoints | job spoofing | `Authorization: Bearer HMAC(job id)`; a token for job A is rejected for job B (tested) |
| Inline buttons | forged/replayed callback data | payloads are *requests*: identity and ownership are re-checked in D1 on every callback; malformed payloads become no-ops (tested) |
| Download links | guessing, reuse after expiry | HMAC-signed `<expiry>.<signature>`, bound to the job id, expiry enforced, R2 object deleted at expiry, `Cache-Control: private, no-store` |
| Resources | abuse, runaway cost | rate limits (URLs and messages/callbacks per minute), per-user and global concurrency (atomic), queue-depth cap, max output bytes, max duration, timeouts per phase, disk pre-check, folder watcher that aborts oversized downloads |
| Filesystem | path traversal | file names sanitised in the Worker *and* again in the container (`safe_filename`); extension chosen from the real container; job ids restricted to `[A-Za-z0-9_-]` |
| Administration | privilege escalation | admin Telegram ids from configuration only; no admin HTTP endpoints; admin callbacks re-check the id |
| Self-hosted engine (free profile) | a stranger registers a malicious engine URL; the tunnel URL is public | `POST /internal/engine/register` needs `Bearer CONTAINER_API_KEY` (constant-time compare; the job-signing secret is *not* accepted); the URL must be `https`, a public host name, no credentials/IP literals/`.local`/`.internal` (422 otherwise, tested); every Worker→engine call carries the key and the engine rejects calls without it, so knowing the tunnel URL is not enough; Telegram `api_hash` and the MTProto session never leave the engine's machine (the free profile does not upload them as Worker secrets) |

## SSRF: four layers

1. **Worker** (`security/url.ts`): only `http`/`https`; no credentials in URLs; blocked ports; numeric-host forms normalised by the
   WHATWG parser (`127.1`, `2130706433`, `0x7f000001`, octal); IPv4 private/loopback/link-local/CGNAT/TEST-NET/multicast and
   IPv6 loopback/ULA/link-local/IPv4-mapped/NAT64/6to4; internal suffixes (`.local`, `.internal`, …); DNS-over-HTTPS resolution
   check (fail-open if DoH is down, because layer 3 still enforces).
2. **Container** (`security.validate_url`): the same rules again, independent code.
3. **Policy proxy** (`security.PolicyProxy`): yt-dlp, the cover/frame downloads and FFmpeg are forced through a local forward proxy
   that **resolves the hostname itself, rejects it unless every answer is public, and connects to the vetted IP**. Because it
   runs per connection, it also covers redirects, DNS rebinding and extractor sub-requests. Tests prove it blocks loopback via both
   plain HTTP and `CONNECT`, and a public-looking name that resolves to loopback.
4. **Platform**: containers are isolated microVMs; the job container exists only for one job.

**Free profile, upstream proxy (`UPSTREAM_PROXY`).** When the engine must reach blocked sites through your own SOCKS5/HTTP proxy, the policy proxy chains through it:
hostname rules and literal-IP rules are still enforced, but name resolution happens at the upstream proxy, so layer 3 cannot vet the address a name resolves to
(DNS-rebinding/"public name → private IP" cases are then only caught by whatever the upstream proxy refuses). The engine also runs on your own machine rather than in a disposable
microVM, so layer 4 is weaker: do not enable `UPSTREAM_PROXY` on a machine with sensitive services on its LAN, and keep the engine's work directory on a dedicated path.

**Residual risks** (documented, not hidden): (a) the proxy is enforced through environment/options — a compromised or malicious
yt-dlp extractor could ignore it; mitigation is pinning + untrusted-input isolation (separate subprocess, no secrets in its
environment, one disposable container per job); (b) whether Cloudflare blocks container→private-IP traffic is **UNVERIFIED**
(see `platform-constraints.md`); (c) because the product must work for "any public site", an origin allow-list is not possible.

## Things the bot deliberately does not do

* It does not bypass DRM, logins, paywalls, CAPTCHAs or "confirm you're not a bot" checks; those failures are reported honestly
  (`drm_protected`, `login_required`, `private_video`, `bot_check`).
* It never asks for or stores website passwords or cookies from users. (Operators may mount a cookies file in the container for
  *their own* account; this project does not ship that feature in the UI.)
* It does not keep media by default: files are deleted after delivery; link-delivery objects expire after `FILE_RETENTION_HOURS`.

## Adult-content sites

Sites supported by yt-dlp's extractors work through the same pipeline. The operator is responsible for lawful use: only lawful adult
content involving consenting adults may be processed; the bot offers `/admin block` to remove abusers, and the privacy text tells
users not to download content they are not authorised to download. Nothing is stored permanently by default.

## Dependency hygiene

`npm run audit:deps` runs `npm audit`; the container's Python dependencies are pinned in `requirements.lock`; the upgrade procedure
(`docs/updating-dependencies.md`) requires the representative-extractor tests to pass before deployment.
