/**
 * Types shared by the Worker and documented as the wire contract of the media container
 * (apps/media-container/app/api.py implements the same JSON shapes).
 */

// ───────────────────────────── Job state machine ─────────────────────────────

export const JOB_STATUSES = [
  "queued",
  "inspecting",
  "ready",
  "downloading",
  "processing",
  "uploading",
  "completed",
  "failed",
  "cancelled",
  "retry_wait",
  "expired",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * Allowed transitions. `queued` is used twice: before inspection (no selection yet) and after the
 * user confirmed a selection (waiting for a processing slot).
 */
export const JOB_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  queued: ["inspecting", "downloading", "cancelled", "failed", "expired"],
  inspecting: ["ready", "failed", "cancelled", "retry_wait"],
  ready: ["queued", "cancelled", "expired"],
  downloading: ["processing", "failed", "cancelled", "retry_wait"],
  processing: ["uploading", "failed", "cancelled", "retry_wait"],
  uploading: ["completed", "failed", "cancelled", "retry_wait"],
  retry_wait: ["queued", "inspecting", "downloading", "failed", "cancelled"],
  failed: ["queued"], // manual retry from the history/status screen
  completed: [],
  cancelled: [],
  expired: [],
};

export const ACTIVE_STATUSES: readonly JobStatus[] = [
  "queued",
  "inspecting",
  "downloading",
  "processing",
  "uploading",
  "retry_wait",
];
export const TERMINAL_STATUSES: readonly JobStatus[] = ["completed", "failed", "cancelled", "expired"];

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

// ───────────────────────────── Errors ─────────────────────────────

export const ERROR_CODES = [
  "invalid_url",
  "blocked_url",
  "unsupported_site",
  "private_video",
  "login_required",
  "geo_restricted",
  "unavailable",
  "drm_protected",
  "rate_limited",
  "bot_check",
  "network_error",
  "too_large",
  "too_long",
  "format_unavailable",
  "ffmpeg_failed",
  "validation_failed",
  "upload_failed",
  "telegram_error",
  "timeout",
  "cancelled",
  "container_lost",
  "disk_full",
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Errors that retrying later can plausibly fix. */
export const RETRYABLE_ERRORS: readonly ErrorCode[] = [
  "network_error",
  "rate_limited",
  "upload_failed",
  "telegram_error",
  "timeout",
  "container_lost",
  "ffmpeg_failed",
  "disk_full", // a fresh container instance starts with a fresh disk
];

// ───────────────────────────── Delivery ─────────────────────────────

export const DELIVERY_MODES = ["bot_api_cloud", "bot_api_local", "mtproto", "r2_link"] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

// ───────────────────────────── Media metadata ─────────────────────────────

export interface MediaFormat {
  formatId: string;
  ext: string;
  /** "video" = has a video stream (may include audio), "audio" = audio only */
  kind: "video" | "audio";
  hasAudio: boolean;
  width: number | null;
  height: number | null;
  fps: number | null;
  vcodec: string | null;
  acodec: string | null;
  dynamicRange: string | null;
  audioLanguage: string | null;
  audioChannels: number | null;
  tbr: number | null;
  filesize: number | null;
  /** true when filesize is an estimate (filesize_approx / bitrate*duration) */
  filesizeApprox: boolean;
  protocol: string | null;
  note: string | null;
}

export interface InspectResult {
  extractor: string;
  site: string;
  originalUrl: string;
  webpageUrl: string;
  title: string;
  description: string | null;
  thumbnail: string | null;
  durationSeconds: number | null;
  uploader: string | null;
  uploadDate: string | null;
  isLive: boolean;
  formats: MediaFormat[];
}

export interface QualityOption {
  /** stable key, e.g. "v1080" or "a" */
  key: string;
  kind: "video" | "audio";
  label: string;
  height: number | null;
  fps: number | null;
  videoFormatId: string | null;
  audioFormatId: string | null;
  ext: string;
  vcodec: string | null;
  acodec: string | null;
  dynamicRange: string | null;
  audioLanguage: string | null;
  estimatedBytes: number | null;
  estimateIsApprox: boolean;
  needsMerge: boolean;
}

// ───────────────────────────── Selection ─────────────────────────────

export type OutputContainer = "original" | "mp4" | "webm" | "mkv" | "mp3" | "m4a";

export interface ThumbnailChoice {
  mode: "original" | "frame" | "custom" | "none";
  /** seconds, for mode=frame */
  frameTimestamp?: number;
  /** Telegram file_id of the user's photo, for mode=custom */
  customFileId?: string;
}

export interface JobSelection {
  kind: "video" | "audio";
  videoFormatId: string | null;
  audioFormatId: string | null;
  /** codecs of the chosen streams, so container compatibility is decided before any download */
  videoCodec: string | null;
  audioCodec: string | null;
  label: string;
  container: OutputContainer;
  title: string;
  filename: string;
  caption: string;
  embedTitle: string | null;
  embedArtist: string | null;
  thumbnail: ThumbnailChoice;
  deliveryMode: DeliveryMode;
  /** how Telegram should show the file */
  sendAs: "auto" | "video" | "document";
  estimatedBytes: number | null;
  /** short side of the selected resolution (1080 for 1920x1080), used to verify the output */
  expectedHeight: number | null;
  /** allow re-encoding when the requested container cannot hold the source codecs (never default) */
  allowTranscode: boolean;
  /**
   * true when the delivery mode came from the automatic policy: if the finished file turns out larger than
   * the chosen Telegram mode can carry, the container delivers an expiring download link instead of failing.
   */
  allowLinkFallback: boolean;
}

/** Source facts the container needs to render the caption and enforce limits. */
export interface JobMeta {
  title: string;
  site: string;
  uploader: string | null;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  webpageUrl: string;
  uploadDate: string | null;
}

// ───────────────────────────── Container wire contract ─────────────────────────────

export interface ContainerInspectRequest {
  url: string;
  correlationId: string;
}

export interface ContainerLimits {
  maxOutputBytes: number;
  maxDurationSeconds: number;
  downloadTimeoutSeconds: number;
  processingTimeoutSeconds: number;
  uploadTimeoutSeconds: number;
  maxTempBytes: number;
}

export interface ContainerStartJobRequest {
  jobId: string;
  correlationId: string;
  url: string;
  selection: JobSelection;
  meta: JobMeta;
  chatId: number;
  replyToMessageId: number | null;
  /** how many times this job was started before (for logs) */
  attempt: number;
  limits: ContainerLimits;
  /** `token` is HMAC(job id) — the container never sees the master signing secret */
  callback: { baseUrl: string; token: string };
}

export interface ContainerJobProgress {
  phase: "downloading" | "processing" | "uploading";
  percent: number | null;
  speedBytesPerSec: number | null;
  etaSeconds: number | null;
  downloadedBytes: number | null;
  totalBytes: number | null;
  detail: string | null;
}

export type ContainerEvent =
  | { type: "progress"; progress: ContainerJobProgress }
  | { type: "state"; status: Extract<JobStatus, "downloading" | "processing" | "uploading"> }
  | { type: "completed"; result: DeliveryResult }
  | { type: "failed"; errorCode: ErrorCode; message: string; retryable: boolean }
  | { type: "heartbeat" };

export interface DeliveryResult {
  mode: DeliveryMode;
  telegramMessageId: number | null;
  telegramFileId: string | null;
  sizeBytes: number;
  filename: string;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  downloadUrl: string | null;
  downloadUrlExpiresAt: string | null;
  sha256: string | null;
}

export interface ContainerJobStatus {
  jobId: string;
  state: "running" | "completed" | "failed" | "cancelled" | "unknown";
  phase: ContainerJobProgress["phase"] | null;
  progress: ContainerJobProgress | null;
  result: DeliveryResult | null;
  errorCode: ErrorCode | null;
  message: string | null;
}

// ───────────────────────────── Queue messages ─────────────────────────────

export type QueueMessage =
  | { type: "inspect"; jobId: string; correlationId: string }
  | { type: "download"; jobId: string; correlationId: string; attempt: number }
  | { type: "frames"; jobId: string; correlationId: string }
  | { type: "cleanup"; jobId: string; correlationId: string };

// ───────────────────────────── Limits ─────────────────────────────

/** Telegram's documented cloud-API upload ceiling for sendVideo/sendDocument/sendAudio (bytes). */
export const TELEGRAM_CLOUD_UPLOAD_LIMIT_BYTES = 50 * 1000 * 1000;
/** Local Bot API server upload ceiling (2000 MB). */
export const TELEGRAM_LOCAL_UPLOAD_LIMIT_BYTES = 2000 * 1000 * 1000;
/** MTProto (bot token + API credentials) upload ceiling: 2000 MB, conservative decimal reading. */
export const TELEGRAM_MTPROTO_UPLOAD_LIMIT_BYTES = 2000 * 1000 * 1000;
