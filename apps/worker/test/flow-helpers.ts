import type { ContainerEvent, DeliveryResult } from "@tvd/shared-types";
import { env } from "cloudflare:workers";
import { handleInternal } from "../src/internal/routes";
import { getJob } from "../src/db/jobs";
import type { JobRow } from "../src/db/types";
import { signJobToken } from "../src/security/hmac";
import { allButtons, buttonData, callback, send, userMessage, type Harness } from "./helpers";

export const ALICE = 1001;
export const BOB = 1002;
export const ADMIN = 9001; // matches ADMIN_USER_IDS in vitest.config.ts

export async function latestJob(h: Harness, userId: number): Promise<JobRow> {
  const row = await h.deps.db.prepare("SELECT * FROM jobs WHERE user_id = ? ORDER BY rowid DESC LIMIT 1").bind(userId).first<JobRow>();
  if (!row) throw new Error(`no job for ${userId}`);
  return row;
}

export async function reload(h: Harness, job: JobRow): Promise<JobRow> {
  return (await getJob(h.deps.db, job.id))!;
}

/** Send a URL as `userId`, run the inspect step, return the job (status `ready`). */
export async function submitAndInspect(h: Harness, userId: number, url = `https://www.youtube.com/watch?v=${Math.random().toString(36).slice(2, 10)}`): Promise<JobRow> {
  await send(h, userMessage(userId, url));
  await h.runQueue();
  return latestJob(h, userId);
}

export async function pressQuality(h: Harness, userId: number, job: JobRow, label: string | RegExp): Promise<void> {
  const data = buttonData(h, label);
  await send(h, callback(userId, data, job.menu_message_id ?? 777));
}

export async function containerEvent(h: Harness, job: JobRow, event: ContainerEvent, opts: { token?: string; jobId?: string } = {}): Promise<{ status: number; body: any }> {
  const jobId = opts.jobId ?? job.id;
  const token = opts.token ?? (await signJobToken(env.INTERNAL_SIGNING_SECRET, job.id));
  const request = new Request(`https://tvd.example.test/internal/jobs/${jobId}/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(event),
  });
  const response = await handleInternal(request, h.deps, new URL(request.url));
  await h.drain();
  return { status: response!.status, body: await response!.json() };
}

export function linkResult(overrides: Partial<DeliveryResult> = {}): DeliveryResult {
  return {
    mode: "r2_link", telegramMessageId: null, telegramFileId: null, sizeBytes: 310_000_000, filename: "Big Buck Bunny.mp4",
    durationSeconds: 600, width: 1920, height: 1080, downloadUrl: "https://tvd.example.test/d/job/123.sig/Big%20Buck%20Bunny.mp4",
    downloadUrlExpiresAt: "2099-01-01T00:00:00.000Z", sha256: "a".repeat(64), ...overrides,
  };
}

export function directResult(overrides: Partial<DeliveryResult> = {}): DeliveryResult {
  return linkResult({ mode: "bot_api_cloud", telegramMessageId: 42, telegramFileId: "FILE", sizeBytes: 5_000_000, downloadUrl: null, downloadUrlExpiresAt: null, ...overrides });
}

export const buttons = allButtons;

/** Drive a job to `downloading` (quality pressed, queue processed). */
export async function startDownload(h: Harness, userId: number, quality: string | RegExp = "1080p60"): Promise<JobRow> {
  const job = await submitAndInspect(h, userId);
  await pressQuality(h, userId, job, quality);
  await h.runQueue();
  return reload(h, job);
}
