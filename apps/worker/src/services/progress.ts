/** The single "status" message of a job: rendered from D1 state, edited with throttling, never duplicated. */
import type { ContainerJobProgress, ErrorCode, JobSelection } from "@tvd/shared-types";
import { RETRYABLE_ERRORS } from "@tvd/shared-types";
import type { Deps } from "../app";
import { type InlineKeyboard, TelegramError } from "../bot/telegram";
import { messages, type Messages } from "../bot/i18n";
import { getJob, jobResult, jobSelection, patchJob } from "../db/jobs";
import type { JobRow } from "../db/types";
import { parseSettings } from "../db/types";
import { getUser } from "../db/users";
import { cancelKeyboard, retryKeyboard } from "../keyboards";

const MIN_EDIT_INTERVAL_SECONDS = 4;

interface StoredProgress extends Partial<ContainerJobProgress> {
  lastEditAt?: number;
  at?: number;
}

function readProgress(job: JobRow): StoredProgress {
  try {
    return job.progress_json ? (JSON.parse(job.progress_json) as StoredProgress) : {};
  } catch {
    return {};
  }
}

export async function messagesFor(deps: Deps, userId: number): Promise<{ m: Messages; language: string; settings: ReturnType<typeof parseSettings> }> {
  const user = await getUser(deps.db, userId);
  return { m: messages(user?.language), language: user?.language ?? "fa", settings: parseSettings(user?.settings_json) };
}

export function renderStatus(m: Messages, job: JobRow): { text: string; markup: InlineKeyboard | undefined } {
  const sel: JobSelection | null = jobSelection(job);
  const progress = readProgress(job);
  const title = sel?.title ?? job.title ?? "";
  const label = sel?.label ?? "";
  switch (job.status) {
    case "queued":
      return { text: sel ? m.statusQueued : m.statusInspect, markup: cancelKeyboard(m, job) };
    case "inspecting":
      return { text: m.statusInspect, markup: cancelKeyboard(m, job) };
    case "downloading":
    case "processing":
    case "uploading": {
      const hasProgress = progress.phase !== undefined;
      if (job.status === "downloading" && !hasProgress) return { text: m.statusStarting, markup: cancelKeyboard(m, job) };
      return {
        text: m.statusProgress({
          title,
          label,
          phase: job.status,
          percent: progress.phase === job.status ? (progress.percent ?? null) : null,
          speed: progress.phase === job.status ? (progress.speedBytesPerSec ?? null) : null,
          eta: progress.phase === job.status ? (progress.etaSeconds ?? null) : null,
          done: progress.phase === job.status ? (progress.downloadedBytes ?? null) : null,
          total: progress.phase === job.status ? (progress.totalBytes ?? null) : null,
          detail: progress.detail ?? null,
        }),
        markup: cancelKeyboard(m, job),
      };
    }
    case "retry_wait": {
      const wait = job.next_retry_at ? Math.max(job.next_retry_at - Math.floor(Date.now() / 1000), 1) : 0;
      return { text: m.statusRetry(job.attempts, job.max_attempts, wait), markup: cancelKeyboard(m, job) };
    }
    case "completed": {
      const result = jobResult(job);
      return { text: m.statusCompleted(title, label, result?.sizeBytes ?? 0), markup: undefined };
    }
    case "failed": {
      const code = (job.error_code ?? "internal") as ErrorCode;
      return { text: m.statusFailed(code, job.error_message), markup: RETRYABLE_ERRORS.includes(code) ? retryKeyboard(m, job) : undefined };
    }
    case "cancelled":
      return { text: m.statusCancelled, markup: undefined };
    case "expired":
      return { text: m.statusExpired, markup: undefined };
    case "ready":
      return { text: m.statusInspect, markup: undefined };
  }
}

/** Create the status message once; afterwards edit it. Returns the message id. */
export async function ensureStatusMessage(deps: Deps, job: JobRow, text?: string): Promise<number | null> {
  if (job.status_message_id) return job.status_message_id;
  const { m } = await messagesFor(deps, job.user_id);
  const rendered = renderStatus(m, job);
  try {
    const sent = await deps.tg.sendMessage(job.chat_id, text ?? rendered.text, rendered.markup ? { reply_markup: rendered.markup } : {});
    await patchJob(deps.db, job.id, { status_message_id: sent.message_id }, deps.now());
    return sent.message_id;
  } catch (error) {
    deps.log.warn("could not create status message", { jobId: job.id, error });
    return null;
  }
}

/**
 * Re-render the job's status message from the database. Progress edits are throttled (Telegram rate limits and
 * user comfort); state changes pass `force: true`. Respects the user's "progress updates" preference.
 */
export async function refreshStatus(deps: Deps, jobId: string, opts: { force?: boolean } = {}): Promise<void> {
  const job = await getJob(deps.db, jobId);
  if (!job) return;
  const { m, settings } = await messagesFor(deps, job.user_id);
  const isProgressOnly = ["downloading", "processing", "uploading"].includes(job.status) && !opts.force;
  if (isProgressOnly && !settings.progressUpdates) return;

  const now = deps.now();
  const stored = readProgress(job);
  if (!opts.force && stored.lastEditAt && now - stored.lastEditAt < MIN_EDIT_INTERVAL_SECONDS) return;

  const rendered = renderStatus(m, job);
  const messageId = job.status_message_id ?? (await ensureStatusMessage(deps, job, rendered.text));
  if (!messageId) return;
  if (job.status_message_id) {
    try {
      await deps.tg.editMessageText(job.chat_id, messageId, rendered.text, rendered.markup);
    } catch (error) {
      if (error instanceof TelegramError && error.retryAfter) {
        // flood control: skip this edit, the next progress event will try again later
        return;
      }
      deps.log.debug("status edit failed", { jobId, error });
    }
  }
  await patchJob(deps.db, job.id, { progress_json: JSON.stringify({ ...stored, lastEditAt: now }) }, now);
}

export function storeProgressPatch(job: JobRow, progress: ContainerJobProgress, now: number): string {
  const prev = readProgress(job);
  return JSON.stringify({ ...progress, lastEditAt: prev.lastEditAt, at: now });
}
