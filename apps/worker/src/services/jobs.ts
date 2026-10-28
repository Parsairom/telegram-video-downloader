/** Job lifecycle: intake → inspect → ready → queued → downloading → processing → uploading → completed. */
import type { ContainerEvent, ContainerJobStatus, ContainerStartJobRequest, DeliveryResult, ErrorCode, InspectResult, JobStatus, QualityOption } from "@tvd/shared-types";
import { RETRYABLE_ERRORS, TERMINAL_STATUSES } from "@tvd/shared-types";
import type { Deps } from "../app";
import type { Messages } from "../bot/i18n";
import type { TgMessage } from "../bot/telegram";
import { containerLimits } from "../config";
import {
  countActiveForUser,
  countByStatus,
  createJob,
  findDuplicate,
  getJob,
  jobIsTerminal,
  jobMetadata,
  jobOptions,
  jobResult,
  jobSelection,
  patchJob,
  transition,
} from "../db/jobs";
import { bumpStat, rateLimit } from "../db/misc";
import type { JobRow, UserRow } from "../db/types";
import { parseSettings } from "../db/types";
import { cancelKeyboard } from "../keyboards";
import { sha256Hex, validateUrl } from "../security/url";
import { signDownloadToken, signJobToken } from "../security/hmac";
import { BackendUnavailable, type InspectOutcome } from "./container";
import { bestWithin, buildOptions, findOption, pickByResolution } from "./formats";
import { showQualityMenu, removeMenuKeyboard } from "./menu";
import { ensureStatusMessage, messagesFor, refreshStatus, storeProgressPatch } from "./progress";
import { buildDraft, containerChoices, reevaluate, toSelection, type Draft } from "./selection";
import { containerCompat } from "./formats";
import { explainRejection } from "./size-policy";

const DEDUPE_WINDOW_SECONDS = 30 * 60;
const MAX_URLS_PER_MESSAGE = 3;

// ───────────────────────────── intake ─────────────────────────────

export async function handleUrls(deps: Deps, user: UserRow, m: Messages, msg: TgMessage, urls: string[]): Promise<void> {
  for (const url of urls.slice(0, MAX_URLS_PER_MESSAGE)) await submitUrl(deps, user, m, msg.chat.id, msg.message_id, url);
}

export async function submitUrl(deps: Deps, user: UserRow, m: Messages, chatId: number, replyTo: number | undefined, raw: string): Promise<JobRow | null> {
  const { tg, db, cfg } = deps;
  const now = deps.now();
  const reply = (text: string) => tg.sendMessage(chatId, text, replyTo ? { reply_to_message_id: replyTo } : {});

  const check = validateUrl(raw);
  if (!check.ok) {
    await reply(check.code === "blocked_url" ? m.blockedUrl(check.reason) : m.invalidUrl);
    return null;
  }
  const dns = await deps.dnsCheck(check.host);
  if (!dns.ok) {
    await reply(m.blockedUrl(dns.reason ?? ""));
    return null;
  }

  if (deps.backend.available && !(await deps.backend.available())) {
    // a self-hosted engine that is not running: say so instead of queueing work nobody will pick up
    await reply(m.engineOffline);
    return null;
  }

  const limit = await rateLimit(db, `url:${user.tg_user_id}`, cfg.rateLimitPerMinute, 60, now);
  if (!limit.allowed) {
    await reply(m.rateLimited(limit.retryAfterSeconds));
    return null;
  }
  if ((await countByStatus(db, ["queued", "inspecting", "retry_wait"])) >= cfg.maxQueuedJobs) {
    await reply(m.queueFull);
    return null;
  }
  const urlHash = await sha256Hex(check.normalized);
  const duplicate = await findDuplicate(db, user.tg_user_id, urlHash, now - DEDUPE_WINDOW_SECONDS);
  if (duplicate) {
    if (duplicate.status === "ready") {
      await showQualityMenu(deps, duplicate);
    } else {
      await reply(m.alreadyProcessing);
    }
    return duplicate;
  }
  if ((await countActiveForUser(db, user.tg_user_id)) >= cfg.maxJobsPerUser) {
    await reply(m.tooManyActive(cfg.maxJobsPerUser));
    return null;
  }

  const job = await createJob(db, {
    userId: user.tg_user_id,
    chatId,
    sourceUrl: check.url.toString(),
    normalizedUrl: check.normalized,
    urlHash,
    maxAttempts: cfg.maxRetries + 1,
    now,
  });
  // The status message is cosmetic: if it cannot be sent the job must still be queued (ensureStatusMessage creates one later),
  // otherwise the row would sit in `queued` with no queue message until the sweeper notices.
  try {
    const status = await tg.sendMessage(chatId, m.inspecting, { reply_markup: cancelKeyboard(m, job), ...(replyTo ? { reply_to_message_id: replyTo } : {}) });
    await patchJob(db, job.id, { status_message_id: status.message_id }, now);
  } catch (error) {
    deps.log.warn("status message not sent; continuing", { jobId: job.id, error });
  }
  await deps.queue.send({ type: "inspect", jobId: job.id, correlationId: job.correlation_id });
  deps.waitUntil(bumpStat(db, "urls_submitted", now));
  deps.log.info("job created", { jobId: job.id, correlationId: job.correlation_id, user: user.tg_user_id });
  return job;
}

// ───────────────────────────── inspect (queue consumer) ─────────────────────────────

export interface StepResult {
  /** ack the queue message */
  done: boolean;
  /** when !done: redeliver after this many seconds */
  retryDelaySeconds?: number;
}

export async function runInspect(deps: Deps, jobId: string, deliveryAttempt: number): Promise<StepResult> {
  const job = await getJob(deps.db, jobId);
  if (!job || (job.status !== "queued" && job.status !== "retry_wait")) return { done: true }; // duplicate delivery
  const now = deps.now();
  if (!(await transition(deps.db, job.id, job.status, "inspecting", now, { next_retry_at: null }, `attempt ${deliveryAttempt}`))) return { done: true };
  const log = deps.log.child({ jobId: job.id, correlationId: job.correlation_id });
  await refreshStatus(deps, job.id, { force: true });

  let outcome: InspectOutcome;
  try {
    outcome = await deps.backend.inspect(job.id, job.source_url, job.correlation_id);
  } catch (error) {
    const message = error instanceof BackendUnavailable ? error.message : String(error);
    outcome = { ok: false, error: { code: "container_lost", message, retryable: true } };
  }

  if (!outcome.ok) {
    log.info("inspect failed", { code: outcome.error.code, retryable: outcome.error.retryable });
    if (outcome.error.retryable && deliveryAttempt < 3) {
      const delay = 10 * 2 ** (deliveryAttempt - 1);
      await transition(deps.db, job.id, "inspecting", "retry_wait", deps.now(), { next_retry_at: deps.now() + delay, error_code: outcome.error.code, error_message: outcome.error.message }, "inspect retry");
      await refreshStatus(deps, job.id, { force: true });
      return { done: false, retryDelaySeconds: delay };
    }
    await failInspect(deps, job, outcome.error.code, outcome.error.message);
    return { done: true };
  }

  if (outcome.data.kind === "playlist") {
    await transition(deps.db, job.id, "inspecting", "ready", deps.now(), { metadata_json: JSON.stringify({ playlist: outcome.data }), title: outcome.data.title }, "playlist");
    await presentPlaylist(deps, job, outcome.data);
    return { done: true };
  }

  const info = outcome.data.info;
  const bundle = buildOptions(info);
  if (bundle.quick.length === 0) {
    await failInspect(deps, job, "unsupported_site", "no downloadable formats");
    return { done: true };
  }
  if (deps.cfg.maxDurationSeconds && info.durationSeconds && info.durationSeconds > deps.cfg.maxDurationSeconds) {
    await failInspect(deps, job, "too_long", `${Math.round(info.durationSeconds / 60)} min`);
    return { done: true };
  }
  const applied = await transition(
    deps.db, job.id, "inspecting", "ready", deps.now(),
    {
      metadata_json: JSON.stringify(info),
      options_json: JSON.stringify(bundle),
      title: info.title,
      site: info.site,
      extractor: info.extractor,
      duration_seconds: info.durationSeconds ? Math.round(info.durationSeconds) : null,
      thumbnail_url: info.thumbnail,
      error_code: null,
      error_message: null,
    },
    "inspected",
  );
  if (!applied) return { done: true }; // cancelled while inspecting
  const ready = (await getJob(deps.db, job.id))!;

  // default-quality preference: skip the menu and start straight away
  const { settings, m, language: _language } = await messagesFor(deps, job.user_id);
  if (settings.defaultResolution !== "ask") {
    const option = settings.defaultResolution === "best" ? bestWithin(bundle, deps.cfg.maxOutputBytes) : pickByResolution(bundle, Number(settings.defaultResolution));
    if (option) {
      const { draft, decision } = buildDraft({ info, option, settings, cfg: deps.cfg });
      if (decision.mode && info.formats.length) {
        const user = { tg_user_id: ready.user_id } as UserRow;
        const started = await startFromDraft(deps, user, m, ready, draft);
        if (started.ok) return { done: true };
      }
    }
  }
  await showQualityMenu(deps, ready);
  await dismissStatusMessage(deps, ready);
  return { done: true };
}

async function failInspect(deps: Deps, job: JobRow, code: ErrorCode, message: string): Promise<void> {
  await transition(deps.db, job.id, "inspecting", "failed", deps.now(), { error_code: code, error_message: message.slice(0, 300) }, "inspect failed");
  deps.waitUntil(bumpStat(deps.db, `fail_${code}`, deps.now()));
  await refreshStatus(deps, job.id, { force: true });
}

async function dismissStatusMessage(deps: Deps, job: JobRow): Promise<void> {
  const current = (await getJob(deps.db, job.id)) ?? job;
  if (current.status_message_id) {
    await deps.tg.deleteMessage(current.chat_id, current.status_message_id);
    await patchJob(deps.db, job.id, { status_message_id: null, progress_json: null }, deps.now());
  }
}

async function presentPlaylist(deps: Deps, job: JobRow, data: Extract<InspectOutcome & { ok: true }, { ok: true }>["data"] & { kind: "playlist" }): Promise<void> {
  const { m } = await messagesFor(deps, job.user_id);
  const { playlistKeyboard } = await import("../keyboards");
  const entries = data.entries.slice(0, 10);
  await deps.tg.sendMessage(job.chat_id, m.playlistPrompt(data.title ?? "", data.total, entries.length), { reply_markup: playlistKeyboard(m, job, entries) });
  await dismissStatusMessage(deps, job);
}

// ───────────────────────────── start ─────────────────────────────

export type StartResult = { ok: true } | { ok: false; reason: string };

export async function startFromDraft(deps: Deps, user: Pick<UserRow, "tg_user_id">, m: Messages, job: JobRow, draftIn: Draft): Promise<StartResult> {
  const { db, cfg } = deps;
  if (job.status !== "ready") return { ok: false, reason: m.menuExpired };
  const info = jobMetadata(job);
  const option = findOption(jobOptions(job), draftIn.optionKey);
  if (!info || !option) return { ok: false, reason: m.menuExpired };

  const { draft, decision } = reevaluate(draftIn, option.estimateIsApprox, cfg);
  if (!decision.mode) return { ok: false, reason: explainRejection(decision) };
  if (!cfg.publicBaseUrl) return { ok: false, reason: "PUBLIC_BASE_URL is not configured (container callbacks and download links need it)" };

  if (draft.kind === "video" && (draft.container === "mp4" || draft.container === "webm") && !draft.allowTranscode) {
    const compat = containerCompat(draft.videoCodec, draft.audioCodec, draft.container);
    if (!compat.ok) return { ok: false, reason: compat.reason ?? "container incompatible" };
  }
  if (cfg.maxDurationSeconds && info.durationSeconds && info.durationSeconds > cfg.maxDurationSeconds) return { ok: false, reason: "too long" };

  if ((await countActiveForUser(db, user.tg_user_id)) >= cfg.maxJobsPerUser) return { ok: false, reason: m.tooManyActive(cfg.maxJobsPerUser).replace(/<[^>]+>/g, "") };
  if ((await countByStatus(db, ["queued", "retry_wait"])) >= cfg.maxQueuedJobs) return { ok: false, reason: m.queueFull };

  const now = deps.now();
  const ok = await transition(
    db, job.id, "ready", "queued", now,
    { selection_json: JSON.stringify(draft), delivery_mode: draft.deliveryMode, attempts: 0, error_code: null, error_message: null, progress_json: null, status_message_id: null },
    `start ${draft.label} ${draft.deliveryMode}`,
  );
  if (!ok) return { ok: false, reason: m.menuExpired };
  const queued = (await getJob(db, job.id))!;
  await removeMenuKeyboard(deps, queued);
  await ensureStatusMessage(deps, queued);
  await deps.queue.send({ type: "download", jobId: job.id, correlationId: job.correlation_id, attempt: 0 });
  deps.waitUntil(bumpStat(db, "downloads_started", now));
  deps.log.info("job queued", { jobId: job.id, correlationId: job.correlation_id, label: draft.label, delivery: draft.deliveryMode, estimatedBytes: draft.estimatedBytes });
  return { ok: true };
}

// ───────────────────────────── download dispatch (queue consumer) ─────────────────────────────

export async function runDownloadDispatch(deps: Deps, jobId: string): Promise<StepResult> {
  const { db, cfg } = deps;
  const job = await getJob(db, jobId);
  if (!job || (job.status !== "queued" && job.status !== "retry_wait")) return { done: true };
  if (job.cancel_requested) return { done: true };
  const draft = jobSelection(job) as Draft | null;
  if (!draft) {
    await transition(db, job.id, job.status, "failed", deps.now(), { error_code: "internal", error_message: "missing selection" });
    return { done: true };
  }
  if (!cfg.publicBaseUrl) {
    await failJob(deps, job, "internal", "PUBLIC_BASE_URL is not configured", false);
    return { done: true };
  }

  const now = deps.now();
  const attempt = job.attempts + 1;
  const claimed = await transition(
    db, job.id, job.status, "downloading", now,
    { attempts: attempt, started_at: job.started_at ?? now, last_heartbeat_at: now, progress_json: null, next_retry_at: null },
    `dispatch attempt ${attempt}`,
    { maxRunning: cfg.maxConcurrentJobs },
  );
  if (!claimed) {
    const fresh = await getJob(db, job.id);
    if (!fresh || (fresh.status !== "queued" && fresh.status !== "retry_wait")) return { done: true }; // someone else took it / cancelled
    return { done: false, retryDelaySeconds: 20 }; // backpressure: all slots busy, try again shortly
  }

  const running = (await getJob(db, job.id))!;
  await refreshStatus(deps, job.id, { force: true });
  const info = jobMetadata(running);
  const request: ContainerStartJobRequest = {
    jobId: job.id,
    correlationId: job.correlation_id,
    url: job.source_url,
    selection: toSelection(draft),
    meta: {
      title: draft.title,
      site: info?.site ?? job.site ?? "",
      uploader: info?.uploader ?? null,
      durationSeconds: info?.durationSeconds ?? job.duration_seconds,
      thumbnailUrl: info?.thumbnail ?? job.thumbnail_url,
      webpageUrl: info?.webpageUrl ?? job.source_url,
      uploadDate: info?.uploadDate ?? null,
    },
    chatId: job.chat_id,
    replyToMessageId: null,
    attempt,
    limits: containerLimits(cfg),
    callback: { baseUrl: cfg.publicBaseUrl, token: await signJobToken(deps.env.INTERNAL_SIGNING_SECRET, job.id) },
  };
  try {
    const status = await deps.backend.startJob(request);
    deps.log.info("container job started", { jobId: job.id, correlationId: job.correlation_id, attempt, containerState: status.state });
    if (status.state === "failed" || status.state === "completed") await reconcileContainerStatus(deps, running, status);
    return { done: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.log.warn("container start failed", { jobId: job.id, error: message });
    await failOrRetry(deps, (await getJob(db, job.id))!, "container_lost", `could not start the media container: ${message}`, true);
    return { done: true };
  }
}

// ───────────────────────────── failure / retry / cancel ─────────────────────────────

export function retryDelaySeconds(attempt: number): number {
  return Math.min(30 * 2 ** Math.max(attempt - 1, 0), 600);
}

export async function failOrRetry(deps: Deps, job: JobRow, code: ErrorCode, message: string, retryable: boolean): Promise<void> {
  if (jobIsTerminal(job)) return;
  const canRetry = retryable && RETRYABLE_ERRORS.includes(code) && job.attempts < job.max_attempts && !job.cancel_requested;
  if (!canRetry) {
    await failJob(deps, job, code, message, retryable);
    return;
  }
  const delay = retryDelaySeconds(job.attempts);
  const now = deps.now();
  const applied = await transition(deps.db, job.id, job.status, "retry_wait", now, { error_code: code, error_message: message.slice(0, 300), next_retry_at: now + delay }, `retry in ${delay}s`);
  if (!applied) return;
  await deps.queue.send({ type: "download", jobId: job.id, correlationId: job.correlation_id, attempt: job.attempts }, { delaySeconds: delay });
  deps.waitUntil(deps.backend.release(job.id));
  await refreshStatus(deps, job.id, { force: true });
  deps.log.info("job will retry", { jobId: job.id, correlationId: job.correlation_id, code, delay });
}

export async function failJob(deps: Deps, job: JobRow, code: ErrorCode, message: string, _retryable: boolean): Promise<void> {
  const applied = await transition(deps.db, job.id, job.status, "failed", deps.now(), { error_code: code, error_message: message.slice(0, 300) }, code);
  if (!applied) return;
  deps.waitUntil(bumpStat(deps.db, `fail_${code}`, deps.now()));
  deps.waitUntil(deps.backend.release(job.id));
  await refreshStatus(deps, job.id, { force: true });
  deps.log.warn("job failed", { jobId: job.id, correlationId: job.correlation_id, code, message });
}

export async function cancelJob(deps: Deps, job: JobRow): Promise<boolean> {
  if (jobIsTerminal(job)) return false;
  const now = deps.now();
  await patchJob(deps.db, job.id, { cancel_requested: 1 }, now);
  const applied = await transition(deps.db, job.id, job.status, "cancelled", now, { error_code: "cancelled" }, "cancelled by user");
  if (!applied) {
    const fresh = await getJob(deps.db, job.id);
    if (fresh && !jobIsTerminal(fresh)) return cancelJob(deps, fresh); // status moved on; retry once against the new state
    return false;
  }
  const running: JobStatus[] = ["downloading", "processing", "uploading"];
  if (running.includes(job.status)) {
    deps.waitUntil(deps.backend.cancel(job.id).then(() => deps.backend.release(job.id)));
  }
  deps.waitUntil(bumpStat(deps.db, "cancelled", now));
  await refreshStatus(deps, job.id, { force: true });
  if (job.menu_message_id) await removeMenuKeyboard(deps, job);
  return true;
}

export async function retryJob(deps: Deps, job: JobRow): Promise<boolean> {
  if (job.status !== "failed" || !jobSelection(job)) return false;
  const now = deps.now();
  const ok = await transition(deps.db, job.id, "failed", "queued", now, { attempts: 0, error_code: null, error_message: null, next_retry_at: null, progress_json: null, finished_at: null }, "manual retry");
  if (!ok) return false;
  await deps.queue.send({ type: "download", jobId: job.id, correlationId: job.correlation_id, attempt: 0 });
  await refreshStatus(deps, job.id, { force: true });
  return true;
}

// ───────────────────────────── container events ─────────────────────────────

/** Advance a job through the legal chain until it reaches `target` (events can arrive out of order or be dropped). */
async function advanceTo(deps: Deps, job: JobRow, target: Extract<JobStatus, "processing" | "uploading" | "completed">, patch: Parameters<typeof transition>[5] = {}): Promise<JobRow | null> {
  const chain: JobStatus[] = ["downloading", "processing", "uploading", "completed"];
  let current = job;
  const from = chain.indexOf(current.status);
  const to = chain.indexOf(target);
  if (from === -1 || to <= from) return from === to ? current : null;
  for (let i = from; i < to; i++) {
    const next = chain[i + 1] as JobStatus;
    const isLast = i + 1 === to;
    const ok = await transition(deps.db, current.id, chain[i] as JobStatus, next, deps.now(), isLast ? patch : {}, "container");
    if (!ok) return null;
    current = { ...current, status: next };
  }
  return (await getJob(deps.db, job.id)) ?? current;
}

const RUNNING_STATUSES: JobStatus[] = ["downloading", "processing", "uploading"];

export async function applyContainerEvent(deps: Deps, job: JobRow, event: ContainerEvent): Promise<{ cancel: boolean }> {
  const now = deps.now();
  if (jobIsTerminal(job)) return { cancel: job.status !== "completed" }; // a late event for a finished job: tell the container to stop
  if (!RUNNING_STATUSES.includes(job.status)) {
    // e.g. retry_wait: the job was already handed back to the queue, so this event comes from a stale container
    deps.log.info("ignoring container event for a job that is not running", { jobId: job.id, status: job.status, type: event.type });
    return { cancel: true };
  }
  const cancelFlag = () => Boolean(job.cancel_requested);

  switch (event.type) {
    case "heartbeat":
      await patchJob(deps.db, job.id, { last_heartbeat_at: now }, now);
      return { cancel: cancelFlag() };

    case "state": {
      if (event.status === "downloading") {
        // the job is already `downloading` since dispatch; the container is just confirming it started
        await patchJob(deps.db, job.id, { last_heartbeat_at: now }, now);
        return { cancel: cancelFlag() };
      }
      const updated = await advanceTo(deps, job, event.status, { last_heartbeat_at: now, progress_json: null });
      if (updated) await refreshStatus(deps, job.id, { force: true });
      return { cancel: cancelFlag() };
    }

    case "progress": {
      await patchJob(deps.db, job.id, { progress_json: storeProgressPatch(job, event.progress, now), last_heartbeat_at: now }, now);
      deps.waitUntil(refreshStatus(deps, job.id));
      return { cancel: cancelFlag() };
    }

    case "completed": {
      const done = await completeJob(deps, job, event.result);
      return { cancel: !done && cancelFlag() };
    }

    case "failed": {
      if (event.errorCode === "cancelled") {
        if (job.cancel_requested) return { cancel: true };
      }
      await failOrRetry(deps, job, event.errorCode, event.message, event.retryable);
      return { cancel: false };
    }
  }
}

export async function completeJob(deps: Deps, job: JobRow, result: DeliveryResult): Promise<boolean> {
  const now = deps.now();
  const finished = await advanceTo(deps, job, "completed", { result_json: JSON.stringify(result), delivery_mode: result.mode, error_code: null, error_message: null, progress_json: null });
  if (!finished) return false;
  deps.waitUntil(Promise.all([bumpStat(deps.db, "completed", now), bumpStat(deps.db, "bytes_delivered", now, result.sizeBytes), bumpStat(deps.db, `delivery_${result.mode}`, now)]));
  const { m } = await messagesFor(deps, job.user_id);
  await refreshStatus(deps, job.id, { force: true });
  if (result.mode === "r2_link" && result.downloadUrl) {
    const sel = jobSelection(finished);
    const reason: "size" | "choice" = sel && sel.deliveryMode === "r2_link" && !(sel as Draft).allowLinkFallback ? "choice" : "size";
    const expiry = result.downloadUrlExpiresAt ? result.downloadUrlExpiresAt.replace("T", " ").slice(0, 16) + " UTC" : "";
    await deps.tg.sendMessage(job.chat_id, m.linkReady(sel?.title ?? job.title ?? "", sel?.label ?? "", result.sizeBytes, result.downloadUrl, expiry, reason), {
      reply_markup: { inline_keyboard: [[{ text: m.btnDownloadLink, url: result.downloadUrl }]] },
    });
  }
  deps.waitUntil(deps.backend.release(job.id));
  deps.log.info("job completed", { jobId: job.id, correlationId: job.correlation_id, mode: result.mode, bytes: result.sizeBytes });
  return true;
}

/** Apply what a polled container status says (used when a callback was lost). */
export async function reconcileContainerStatus(deps: Deps, job: JobRow, status: ContainerJobStatus): Promise<void> {
  if (jobIsTerminal(job)) return;
  if (status.state === "completed" && status.result) {
    await completeJob(deps, job, status.result);
  } else if (status.state === "failed") {
    const code = (status.errorCode ?? "internal") as ErrorCode;
    if (code === "cancelled" && job.cancel_requested) return;
    await failOrRetry(deps, job, code, status.message ?? "failed", RETRYABLE_ERRORS.includes(code));
  } else if (status.state === "running" && status.progress) {
    await patchJob(deps.db, job.id, { progress_json: storeProgressPatch(job, status.progress, deps.now()), last_heartbeat_at: deps.now() }, deps.now());
  }
}

// ───────────────────────────── helpers used by other modules ─────────────────────────────

export function jobTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function optionOf(job: JobRow, key: string): QualityOption | null {
  return findOption(jobOptions(job), key);
}

export function infoOf(job: JobRow): InspectResult | null {
  return jobMetadata(job);
}

export function resultOf(job: JobRow): DeliveryResult | null {
  return jobResult(job);
}

export { containerChoices, parseSettings, signDownloadToken };
