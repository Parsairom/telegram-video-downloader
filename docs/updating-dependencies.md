# Updating yt-dlp, FFmpeg and other dependencies

Sites change weekly and yt-dlp's stable channel "is often stale and prone to external breakage" (upstream wording) — but untested
upgrades are how a working bot breaks. Production therefore runs **pinned** versions and only upgrades through this procedure.
Nothing in this repository updates dependencies automatically.

## Pinned versions

* `apps/media-container/requirements.lock` — exact versions of yt-dlp (`2026.10.21`), yt-dlp-ejs, httpx, FastAPI, … installed by the Dockerfile.
* FFmpeg/FFprobe — the Debian 13 package in the base image `python:3.13-slim-trixie`; Node 22 is copied from `node:22-bookworm-slim`.
  Pin the images by digest (`FROM …@sha256:…`) once you settle on a build.
* npm — `package-lock.json`.

## Upgrade yt-dlp (the common case)

1. Check upstream's release notes (<https://github.com/yt-dlp/yt-dlp/releases>), for stable and — if a site is broken — the nightly build.
2. Edit the version in `apps/media-container/pyproject.toml`, then `npm run lock:container` (rebuilds `requirements.lock` in a clean venv).
3. Run the container tests: `npm run test:container` (needs `ffmpeg` + `ffprobe`). They include end-to-end jobs against local fixture servers
   (direct MP4, HLS with separate audio/video, cancel, failure, size limits, link delivery).
4. Run the opt-in **representative extractor** checks against real sites you care about:
   `python -m pytest apps/media-container/tests -m network` (add your own URLs in `tests/test_network_extractors.py`; they only inspect metadata, no downloads).
5. Build the image and smoke-test it: `docker build apps/media-container`, run it, `GET /health`, `POST /inspect` with a known URL.
6. Deploy: `npm run deploy`. The container rollout replaces instances gradually; running jobs on an old instance finish or are retried.
7. Verify with `/admin health` (shows the running yt-dlp version) and one real download. To roll back, redeploy the previous revision.

## Upgrade FFmpeg / the base image

Change the base image tag (or digest) in the Dockerfile, rebuild, run the container tests (they exercise merge, remux, faststart, thumbnails,
transcode and validation) and then follow steps 5–7.

## Upgrade the Worker's npm dependencies

`npm outdated`, update, then `npm run test:all` and `npm run audit:deps`. Pay attention to `wrangler`, `@cloudflare/containers` and
`@cloudflare/vitest-plugin` (their versions move together with the runtime).
