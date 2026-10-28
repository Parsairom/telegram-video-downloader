import type { ErrorCode, JobStatus } from "@tvd/shared-types";
import { z } from "zod";

export interface UserRow {
  tg_user_id: number;
  username: string | null;
  first_name: string | null;
  language: string;
  is_blocked: number;
  block_reason: string | null;
  settings_json: string;
  state: string | null;
  state_json: string | null;
  state_updated_at: number | null;
  total_jobs: number;
  created_at: number;
  last_seen_at: number;
}

export interface JobRow {
  id: string;
  short_id: string;
  user_id: number;
  chat_id: number;
  correlation_id: string;
  source_url: string;
  normalized_url: string;
  url_hash: string;
  status: JobStatus;
  extractor: string | null;
  site: string | null;
  title: string | null;
  duration_seconds: number | null;
  thumbnail_url: string | null;
  metadata_json: string | null;
  options_json: string | null;
  selection_json: string | null;
  delivery_mode: string | null;
  result_json: string | null;
  error_code: ErrorCode | null;
  error_message: string | null;
  attempts: number;
  max_attempts: number;
  next_retry_at: number | null;
  progress_json: string | null;
  last_heartbeat_at: number | null;
  status_message_id: number | null;
  menu_message_id: number | null;
  menu_is_photo: number;
  cancel_requested: number;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
  expires_at: number | null;
}

/** Per-user preferences (stored as JSON in users.settings_json). Unknown/missing keys fall back to defaults. */
export const UserSettingsSchema = z.object({
  defaultResolution: z.enum(["ask", "best", "2160", "1440", "1080", "720", "480", "360", "240", "144"]).default("ask"),
  defaultContainer: z.enum(["auto", "mp4", "webm", "original"]).default("auto"),
  quickStart: z.boolean().default(true),
  thumbnailMode: z.enum(["original", "frame", "none"]).default("original"),
  deliveryPreference: z.enum(["auto", "bot_api_cloud", "bot_api_local", "mtproto", "r2_link"]).default("auto"),
  sendAs: z.enum(["auto", "document"]).default("auto"),
  defaultCaption: z.string().max(900).nullable().default(null),
  progressUpdates: z.boolean().default(true),
  embedMetadata: z.boolean().default(false),
});
export type UserSettings = z.infer<typeof UserSettingsSchema>;

export function parseSettings(raw: string | null | undefined): UserSettings {
  try {
    const parsed = UserSettingsSchema.safeParse(raw ? JSON.parse(raw) : {});
    if (parsed.success) return parsed.data;
  } catch {
    /* fall through to defaults */
  }
  return UserSettingsSchema.parse({});
}

/** What the bot is waiting for the user to type / send. */
export const UserStateSchema = z.object({
  kind: z.enum(["await_title", "await_filename", "await_caption", "await_embed_title", "await_embed_artist", "await_thumbnail", "await_default_caption"]),
  jobShortId: z.string().nullable().default(null),
});
export type UserState = z.infer<typeof UserStateSchema>;
