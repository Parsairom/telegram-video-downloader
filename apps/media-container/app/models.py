"""Request/response models of the container API (mirror of packages/shared-types)."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class _Model(BaseModel):
    model_config = ConfigDict(extra="ignore")


class ThumbnailChoice(_Model):
    mode: Literal["original", "frame", "custom", "none"] = "original"
    frameTimestamp: float | None = None
    customFileId: str | None = None


class Selection(_Model):
    kind: Literal["video", "audio"]
    videoFormatId: str | None = None
    audioFormatId: str | None = None
    videoCodec: str | None = None
    audioCodec: str | None = None
    label: str = ""
    container: Literal["original", "mp4", "webm", "mkv", "mp3", "m4a"] = "original"
    title: str = ""
    filename: str = ""
    caption: str = "<b>{title}</b>"
    embedTitle: str | None = None
    embedArtist: str | None = None
    thumbnail: ThumbnailChoice = Field(default_factory=ThumbnailChoice)
    deliveryMode: Literal["bot_api_cloud", "bot_api_local", "mtproto", "r2_link"] = "bot_api_cloud"
    sendAs: Literal["auto", "video", "document"] = "auto"
    estimatedBytes: int | None = None
    expectedHeight: int | None = None
    allowTranscode: bool = False
    allowLinkFallback: bool = False


class Meta(_Model):
    title: str = ""
    site: str = ""
    uploader: str | None = None
    durationSeconds: float | None = None
    thumbnailUrl: str | None = None
    webpageUrl: str = ""
    uploadDate: str | None = None


class Limits(_Model):
    maxOutputBytes: int = 1_900_000_000
    maxDurationSeconds: int = 0  # 0 = unlimited
    downloadTimeoutSeconds: int = 3600
    processingTimeoutSeconds: int = 1800
    uploadTimeoutSeconds: int = 3600
    maxTempBytes: int = 15_000_000_000


class Callback(_Model):
    baseUrl: str
    token: str


class StartJobRequest(_Model):
    jobId: str = Field(min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    correlationId: str = ""
    url: str
    selection: Selection
    meta: Meta = Field(default_factory=Meta)
    chatId: int
    replyToMessageId: int | None = None
    attempt: int = 0
    limits: Limits = Field(default_factory=Limits)
    callback: Callback


class InspectRequest(_Model):
    url: str
    correlationId: str = ""


class FramesRequest(_Model):
    url: str
    formatId: str
    durationSeconds: float | None = None
    count: int = Field(default=5, ge=1, le=8)
    correlationId: str = ""
