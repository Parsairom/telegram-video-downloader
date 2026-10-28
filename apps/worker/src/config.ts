import type { ContainerLimits, DeliveryMode } from "@tvd/shared-types";
import { TELEGRAM_CLOUD_UPLOAD_LIMIT_BYTES, TELEGRAM_LOCAL_UPLOAD_LIMIT_BYTES, TELEGRAM_MTPROTO_UPLOAD_LIMIT_BYTES } from "@tvd/shared-types";
import { z } from "zod";

const int = (def: number, min = 0) => z.coerce.number().int().min(min).default(def);

/** Every setting that arrives through `vars` / secrets, validated once. Bytes are used internally everywhere. */
export const EnvSchema = z.object({
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  TELEGRAM_DELIVERY_MODE: z.enum(["auto", "bot_api_cloud", "bot_api_local", "mtproto", "r2_link"]).default("auto"),
  /** "container" = Cloudflare Containers (paid plan); "http" = a self-hosted engine that registers itself (free plan). */
  MEDIA_BACKEND: z.enum(["container", "http"]).default("container"),
  /** the engine has TELEGRAM_API_ID/HASH and can upload up to ~2 GB over MTProto */
  MTPROTO_ENABLED: z.enum(["true", "false"]).default("false"),
  MAX_OUTPUT_BYTES: int(1_900_000_000, 1_000_000),
  MAX_CONCURRENT_JOBS: int(3, 1),
  MAX_JOBS_PER_USER: int(2, 1),
  MAX_QUEUED_JOBS: int(40, 1),
  MAX_DURATION_SECONDS: int(0),
  MAX_RETRIES: int(3),
  DOWNLOAD_TIMEOUT: int(3600, 30),
  PROCESSING_TIMEOUT: int(1800, 30),
  UPLOAD_TIMEOUT: int(3600, 30),
  MAX_TEMP_BYTES: int(14_000_000_000, 100_000_000),
  FILE_RETENTION_HOURS: int(24, 1),
  HISTORY_RETENTION_DAYS: int(30, 1),
  RATE_LIMIT_PER_MINUTE: int(6, 1),
  TEMP_DIRECTORY: z.string().default("/work"),
  LOCAL_BOT_API_ENABLED: z.enum(["true", "false"]).default("false"),
  INSPECTOR_POOL_SIZE: int(2, 1),
  PUBLIC_BASE_URL: z.string().url().optional(),
  ADMIN_USER_IDS: z.string().default(""),
  TELEGRAM_API_ID: z.string().optional(),
  TELEGRAM_API_HASH: z.string().optional(),
});

export interface Config {
  logLevel: "debug" | "info" | "warn" | "error";
  deliveryPolicy: "auto" | DeliveryMode;
  mediaBackend: "container" | "http";
  mtprotoEnabled: boolean;
  mtprotoUploadLimitBytes: number;
  /** R2 bucket bound AND a public base URL: expiring download links can be produced */
  linkDeliveryEnabled: boolean;
  maxOutputBytes: number;
  maxConcurrentJobs: number;
  maxJobsPerUser: number;
  maxQueuedJobs: number;
  maxDurationSeconds: number;
  maxRetries: number;
  downloadTimeoutSeconds: number;
  processingTimeoutSeconds: number;
  uploadTimeoutSeconds: number;
  maxTempBytes: number;
  fileRetentionHours: number;
  historyRetentionDays: number;
  rateLimitPerMinute: number;
  tempDirectory: string;
  localBotApiEnabled: boolean;
  inspectorPoolSize: number;
  publicBaseUrl: string | null;
  adminIds: Set<number>;
  cloudUploadLimitBytes: number;
  localUploadLimitBytes: number;
  /** runtime flag toggled by `/admin maintenance on|off` (stored in D1, not in the environment) */
  maintenance: boolean;
}

export class ConfigError extends Error {}

export function parseAdminIds(raw: string | undefined): Set<number> {
  const ids = new Set<number>();
  for (const part of (raw ?? "").split(/[,\s;]+/)) {
    if (/^\d{3,}$/.test(part)) ids.add(Number(part));
  }
  return ids;
}

/** Validate environment values. Throws ConfigError with a readable message listing every problem. */
export function parseConfig(env: Record<string, unknown>): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigError(`invalid configuration: ${problems}`);
  }
  const e = parsed.data;
  const localConfigured = e.LOCAL_BOT_API_ENABLED === "true" && Boolean(e.TELEGRAM_API_ID) && Boolean(e.TELEGRAM_API_HASH);
  if (e.TELEGRAM_DELIVERY_MODE === "bot_api_local" && !localConfigured) {
    throw new ConfigError("TELEGRAM_DELIVERY_MODE=bot_api_local requires LOCAL_BOT_API_ENABLED=true, TELEGRAM_API_ID and TELEGRAM_API_HASH");
  }
  const linkDeliveryEnabled = env.MEDIA_BUCKET != null && Boolean(e.PUBLIC_BASE_URL);
  if (e.TELEGRAM_DELIVERY_MODE === "r2_link" && !linkDeliveryEnabled) {
    throw new ConfigError("TELEGRAM_DELIVERY_MODE=r2_link requires an R2 bucket binding and PUBLIC_BASE_URL");
  }
  if (e.TELEGRAM_DELIVERY_MODE === "mtproto" && e.MTPROTO_ENABLED !== "true") {
    throw new ConfigError("TELEGRAM_DELIVERY_MODE=mtproto requires MTPROTO_ENABLED=true (and TELEGRAM_API_ID/HASH on the media engine)");
  }
  return {
    logLevel: e.LOG_LEVEL,
    deliveryPolicy: e.TELEGRAM_DELIVERY_MODE,
    mediaBackend: e.MEDIA_BACKEND,
    mtprotoEnabled: e.MTPROTO_ENABLED === "true",
    mtprotoUploadLimitBytes: TELEGRAM_MTPROTO_UPLOAD_LIMIT_BYTES,
    linkDeliveryEnabled,
    maxOutputBytes: e.MAX_OUTPUT_BYTES,
    maxConcurrentJobs: e.MAX_CONCURRENT_JOBS,
    maxJobsPerUser: e.MAX_JOBS_PER_USER,
    maxQueuedJobs: e.MAX_QUEUED_JOBS,
    maxDurationSeconds: e.MAX_DURATION_SECONDS,
    maxRetries: e.MAX_RETRIES,
    downloadTimeoutSeconds: e.DOWNLOAD_TIMEOUT,
    processingTimeoutSeconds: e.PROCESSING_TIMEOUT,
    uploadTimeoutSeconds: e.UPLOAD_TIMEOUT,
    maxTempBytes: e.MAX_TEMP_BYTES,
    fileRetentionHours: e.FILE_RETENTION_HOURS,
    historyRetentionDays: e.HISTORY_RETENTION_DAYS,
    rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
    tempDirectory: e.TEMP_DIRECTORY,
    localBotApiEnabled: localConfigured,
    inspectorPoolSize: e.INSPECTOR_POOL_SIZE,
    publicBaseUrl: e.PUBLIC_BASE_URL ? e.PUBLIC_BASE_URL.replace(/\/+$/, "") : null,
    adminIds: parseAdminIds(e.ADMIN_USER_IDS),
    cloudUploadLimitBytes: TELEGRAM_CLOUD_UPLOAD_LIMIT_BYTES,
    localUploadLimitBytes: TELEGRAM_LOCAL_UPLOAD_LIMIT_BYTES,
    maintenance: false,
  };
}

/** Keys an administrator may change at runtime (stored in D1 `app_config`) and how to apply them. */
export const RUNTIME_KEYS = {
  max_concurrent_jobs: { min: 1, max: 20, apply: (c: Config, v: number) => void (c.maxConcurrentJobs = v) },
  max_jobs_per_user: { min: 1, max: 10, apply: (c: Config, v: number) => void (c.maxJobsPerUser = v) },
  max_queued_jobs: { min: 1, max: 500, apply: (c: Config, v: number) => void (c.maxQueuedJobs = v) },
  max_duration_seconds: { min: 0, max: 86_400, apply: (c: Config, v: number) => void (c.maxDurationSeconds = v) },
  rate_limit_per_minute: { min: 1, max: 60, apply: (c: Config, v: number) => void (c.rateLimitPerMinute = v) },
  max_retries: { min: 0, max: 10, apply: (c: Config, v: number) => void (c.maxRetries = v) },
} as const;
export type RuntimeKey = keyof typeof RUNTIME_KEYS;

export function isRuntimeKey(key: string): key is RuntimeKey {
  return Object.prototype.hasOwnProperty.call(RUNTIME_KEYS, key);
}

export function validateRuntimeValue(key: RuntimeKey, value: number): string | null {
  const rule = RUNTIME_KEYS[key];
  if (!Number.isInteger(value) || value < rule.min || value > rule.max) return `${key} must be an integer between ${rule.min} and ${rule.max}`;
  return null;
}

export function containerLimits(c: Config): ContainerLimits {
  return {
    maxOutputBytes: c.maxOutputBytes,
    maxDurationSeconds: c.maxDurationSeconds,
    downloadTimeoutSeconds: c.downloadTimeoutSeconds,
    processingTimeoutSeconds: c.processingTimeoutSeconds,
    uploadTimeoutSeconds: c.uploadTimeoutSeconds,
    maxTempBytes: c.maxTempBytes,
  };
}
