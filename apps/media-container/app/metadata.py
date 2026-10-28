"""Filenames, captions and embedded-metadata helpers. The three concepts are kept strictly separate:

* Telegram caption   -> `render_caption` (HTML, <=1024 chars, placeholders filled with real values)
* file name          -> `safe_filename` (sanitised, extension chosen from the real container)
* embedded metadata  -> written by ffmpeg_service via -metadata (title / artist only)
"""
from __future__ import annotations

import html
import re
import unicodedata
from typing import Any

CAPTION_LIMIT = 1024
_RESERVED_WIN = {
    "con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10)),
}
_SAFE_EXT = {".mp4", ".webm", ".mkv", ".mp3", ".m4a", ".mov", ".m4v", ".ogg", ".opus", ".flac", ".wav", ".aac"}


def safe_filename(name: str, extension: str, *, max_stem: int = 120) -> str:
    """Return `<sanitised stem><extension>` — no path separators, control chars, reserved names or odd extensions."""
    extension = extension.lower() if extension.lower() in _SAFE_EXT else ".bin"
    stem = unicodedata.normalize("NFKC", name or "")
    # drop an extension the user typed if it matches ours, so "clip.mp4" does not become "clip.mp4.mp4"
    if stem.lower().endswith(extension):
        stem = stem[: -len(extension)]
    stem = re.sub(r"[\x00-\x1f\x7f<>:\"/\\|?*]", " ", stem)
    stem = re.sub(r"[\u200b-\u200f\u202a-\u202e\u2066-\u2069]", "", stem)  # bidi / zero-width controls
    stem = re.sub(r"\s+", " ", stem).strip(" .")
    stem = stem.lstrip("-")  # never start with an option-looking dash
    if stem.lower() in _RESERVED_WIN:
        stem = f"_{stem}"
    stem = stem[:max_stem].rstrip(" .")
    return (stem or "video") + extension


def human_size(n: int | float | None) -> str:
    if not n:
        return "?"
    n = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return "?"


def human_duration(seconds: float | int | None) -> str:
    if not seconds:
        return "?"
    seconds = int(round(seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


_PLACEHOLDER = re.compile(r"\{(title|site|duration|resolution|size|url|uploader|date|filename)\}")


def render_caption(template: str, values: dict[str, Any]) -> str:
    """Fill placeholders (HTML-escaped) in a caption template and enforce Telegram's 1024-char limit.

    The template itself is trusted HTML produced by the Worker (only <b>, <i>, <a href>); user text inside
    it was already escaped there. Values coming from the web (title, uploader...) are escaped here.
    """
    plain_limit_marker = "…"

    def substitute(limit_title: int) -> str:
        def repl(m: re.Match[str]) -> str:
            key = m.group(1)
            raw = str(values.get(key, "") or "")
            if key == "title":
                raw = raw[:limit_title]
            return html.escape(raw, quote=False)

        return _PLACEHOLDER.sub(repl, template)

    title_limit = 300
    text = substitute(title_limit)
    while _plain_len(text) > CAPTION_LIMIT and title_limit > 40:
        title_limit -= 40
        text = substitute(title_limit)
    if _plain_len(text) > CAPTION_LIMIT:
        # Last resort: cut visible text; strip tags first so we never leave an unclosed one.
        plain = html.escape(html.unescape(re.sub(r"<[^>]+>", "", text))[: CAPTION_LIMIT - 1], quote=False)
        text = plain + plain_limit_marker
    return text


def _plain_len(text: str) -> int:
    return len(html.unescape(re.sub(r"<[^>]+>", "", text)))
