"""Error taxonomy shared with the Worker (see packages/shared-types ERROR_CODES)."""
from __future__ import annotations

import re

RETRYABLE = {
    "network_error",
    "rate_limited",
    "upload_failed",
    "telegram_error",
    "timeout",
    "container_lost",
    "ffmpeg_failed",
    "disk_full",  # a fresh container instance starts with a fresh disk
}


class MediaError(Exception):
    def __init__(self, code: str, message: str, *, retryable: bool | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = (code in RETRYABLE) if retryable is None else retryable

    def to_dict(self) -> dict:
        return {"code": self.code, "message": self.message, "retryable": self.retryable}


class JobCancelled(Exception):
    """Raised inside the runner when the job was cancelled."""


# (regex, code) — first match wins. Messages come from yt-dlp, ffmpeg, httpx and our own checks.
_RULES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"confirm you.re not a bot|sign in to confirm|captcha|bot detection|cf-chl|cloudflare.*challenge|all player responses are invalid|your ip is likely being blocked|content isn.t available, try again later|rate-limited by youtube", re.I), "bot_check"),
    (re.compile(r"\bdrm\b|widevine|playready|fairplay|protected by drm", re.I), "drm_protected"),
    (re.compile(r"private video|this video is private|is private|members[- ]only|premium (?:content|members)|subscribers[- ]only", re.I), "private_video"),
    (re.compile(r"login required|log in|sign in|authentication required|cookies|age[- ]restricted|confirm your age|requires? (?:a )?(?:login|account|payment)|http error 40[13]\b", re.I), "login_required"),
    (re.compile(r"(?:not )?available in your (?:country|region|location)|geo[- ]?(?:restrict|block)|blocked it in your country|your country|region[- ](?:locked|restricted)", re.I), "geo_restricted"),
    (re.compile(r"unsupported url|no suitable extractor|unable to extract|no video formats found|no video could be found|there.s no video", re.I), "unsupported_site"),
    (re.compile(r"requested format is not available|format .* not available|no matching format", re.I), "format_unavailable"),
    (re.compile(r"larger than max-filesize|file is larger than|exceeds .* limit|too large|too big", re.I), "too_large"),
    (re.compile(r"http error 429|too many requests|rate[- ]limit|slow down", re.I), "rate_limited"),
    (re.compile(r"video (?:is )?unavailable|has been removed|was deleted|no longer available|not found|http error 404|http error 410|does not exist|content isn.t available|taken down", re.I), "unavailable"),
    (re.compile(r"no space left|disk full|enospc", re.I), "disk_full"),
    (re.compile(r"timed out|timeout|connection (?:reset|refused|aborted|error)|temporary failure|name or service not known|network is unreachable|getaddrinfo|ssl|eof occurred|incompleteread|remote end closed|http error 5\d\d|cannot resolve", re.I), "network_error"),
]


def classify_error(message: str) -> tuple[str, bool]:
    """Map a raw error string to (error_code, retryable)."""
    text = message or ""
    for pattern, code in _RULES:
        if pattern.search(text):
            return code, code in RETRYABLE
    return "internal", False
