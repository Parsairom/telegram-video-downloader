# syntax=docker/dockerfile:1.7
# Media container: Python + yt-dlp + FFmpeg/FFprobe + Node (yt-dlp JS challenge runtime) + job API.
# Build for linux/amd64 (the only architecture Cloudflare Containers runs).
#
#   docker build --platform linux/amd64 -t tvd-media apps/media-container
#   docker build --platform linux/amd64 --build-arg WITH_LOCAL_BOT_API=1 -t tvd-media-botapi apps/media-container
#
# WITH_LOCAL_BOT_API=1 compiles tdlib/telegram-bot-api (needs several GB of RAM and 20-40 minutes). It is OFF by
# default; see docs/large-file-delivery.md before enabling it.

ARG PYTHON_VERSION=3.13
ARG DEBIAN_RELEASE=trixie

# ---------------------------------------------------------------- Node 22 (yt-dlp needs >= 22 for YouTube JS challenges)
FROM node:22-bookworm-slim AS node

# ---------------------------------------------------------------- optional: local Telegram Bot API server
FROM debian:${DEBIAN_RELEASE}-slim AS botapi-build
ARG WITH_LOCAL_BOT_API=0
ARG TELEGRAM_BOT_API_REF=master
RUN mkdir -p /opt/botapi/bin
RUN if [ "$WITH_LOCAL_BOT_API" = "1" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends make git zlib1g-dev libssl-dev gperf cmake g++ ca-certificates \
      && git clone --recursive --depth 1 --branch "$TELEGRAM_BOT_API_REF" https://github.com/tdlib/telegram-bot-api.git /src \
      && mkdir /src/build && cd /src/build \
      && cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX:PATH=/opt/botapi .. \
      && cmake --build . --target install -j2 \
      && strip /opt/botapi/bin/telegram-bot-api \
      && rm -rf /var/lib/apt/lists/* /src ; \
    fi

# ---------------------------------------------------------------- runtime
FROM python:${PYTHON_VERSION}-slim-${DEBIAN_RELEASE} AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    WORK_DIR=/work \
    PORT=8080 \
    YTDLP_NO_PLUGINS=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libstdc++6 ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && ffmpeg -version | head -1 && ffprobe -version | head -1

COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN node --version

WORKDIR /srv
COPY requirements.lock /srv/requirements.lock
RUN pip install -r /srv/requirements.lock

COPY --from=botapi-build /opt/botapi/bin/ /usr/local/bin/
COPY app /srv/app

RUN useradd --system --uid 10001 --create-home --home-dir /home/app app \
    && mkdir -p /work \
    && chown -R app:app /work /srv
USER app

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=3).status == 200 else 1)"

ENTRYPOINT ["tini", "--"]
CMD ["uvicorn", "app.api:app", "--host", "0.0.0.0", "--port", "8080", "--no-access-log", "--timeout-graceful-shutdown", "25"]
