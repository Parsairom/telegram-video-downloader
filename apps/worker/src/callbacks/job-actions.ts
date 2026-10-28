/** Inline-button actions that operate on one job. Every action re-checks that the pressing user owns the job. */
import type { Deps } from "../app";
import type { Messages } from "../bot/i18n";
import { formatBytes, formatDate } from "../bot/format";
import type { TgCallbackQuery } from "../bot/telegram";
import { getJob, getJobByShortId, jobMetadata, jobOptions, jobResult, jobSelection, patchJob, transition } from "../db/jobs";
import type { JobRow, UserRow, UserSettings } from "../db/types";
import { setUserState } from "../db/users";
import { audioTracksKeyboard, containerKeyboard, deliveryKeyboard, framesKeyboard, thumbnailKeyboard } from "../keyboards";
import { cancelJob, retryJob, startFromDraft, submitUrl } from "../services/jobs";
import { bestWithin, containerCompat, findOption, resolveContainer } from "../services/formats";
import { currentDraft, editMenu, renderAdvanced, renderCustomize, renderQualityMenu } from "../services/menu";
import { messagesFor } from "../services/progress";
import { buildDraft, containerChoices, type Draft, reevaluate } from "../services/selection";
import { explainRejection } from "../services/size-policy";
import { type JobAction } from "./codec";

interface Ctx {
  deps: Deps;
  cq: TgCallbackQuery;
  user: UserRow;
  m: Messages;
  settings: UserSettings;
  job: JobRow;
  arg: string | null;
  answer(text?: string, alert?: boolean): Promise<void>;
}

const READY_ONLY = new Set<JobAction>(["q", "qa", "qt", "cu", "th", "ths", "thp", "thf", "thu", "ed", "ed0", "ct", "cts", "tc", "dm", "dms", "sa", "go", "bk"]);

export async function handleJobAction(deps: Deps, cq: TgCallbackQuery, user: UserRow, action: JobAction, shortId: string, arg: string | null): Promise<void> {
  const { m, settings } = await messagesFor(deps, user.tg_user_id);
  const answer = (text?: string, alert = false) => deps.tg.answerCallbackQuery(cq.id, text, alert);
  const job = await getJobByShortId(deps.db, shortId);
  if (!job) return answer(m.jobNotFound, true);
  if (job.user_id !== cq.from.id) return answer(m.notYourItem, true); // never trust the payload for ownership
  const ctx: Ctx = { deps, cq, user, m, settings, job, arg, answer };

  if (READY_ONLY.has(action) && job.status !== "ready") return answer(m.menuExpired, true);

  switch (action) {
    case "cx":
      return cancel(ctx);
    case "rt":
      return retry(ctx);
    case "cl":
      return close(ctx);
    case "hd":
      return historyDetail(ctx);
    case "pl":
      return pickPlaylistEntry(ctx);
    case "q":
      return pickQuality(ctx);
    case "qa":
      return showAdvanced(ctx);
    case "qt":
      return showAudioTracks(ctx);
    case "bk":
      return backToMenu(ctx);
    case "cu":
      return showCustomize(ctx);
    case "th":
      return showThumbnails(ctx);
    case "ths":
      return setThumbnailMode(ctx);
    case "thp":
      return previewFrames(ctx);
    case "thf":
      return chooseFrame(ctx);
    case "thu":
      return askThumbnailUpload(ctx);
    case "ed":
      return askEdit(ctx);
    case "ed0":
      return clearMetadata(ctx);
    case "ct":
      return showContainers(ctx);
    case "cts":
      return setContainer(ctx);
    case "tc":
      return toggleTranscode(ctx);
    case "dm":
      return showDelivery(ctx);
    case "dms":
      return setDelivery(ctx);
    case "sa":
      return toggleSendAs(ctx);
    case "go":
      return go(ctx);
  }
}

// ───────────────────────── helpers ─────────────────────────

async function ensureDraft(c: Ctx): Promise<Draft | null> {
  const existing = currentDraft(c.job);
  if (existing) return existing;
  const info = jobMetadata(c.job);
  const bundle = jobOptions(c.job);
  const option = bestWithin(bundle, c.deps.cfg.maxOutputBytes);
  if (!info || !option) return null;
  const { draft } = buildDraft({ info, option, settings: c.settings, cfg: c.deps.cfg });
  await saveDraft(c, draft);
  return draft;
}

async function saveDraft(c: Ctx, draft: Draft): Promise<void> {
  await patchJob(c.deps.db, c.job.id, { selection_json: JSON.stringify(draft) }, c.deps.now());
  c.job = { ...c.job, selection_json: JSON.stringify(draft) };
}

async function renderCustomizeScreen(c: Ctx, draft: Draft): Promise<void> {
  const r = await renderCustomize(c.deps, c.job, draft);
  await editMenu(c.deps, c.job, r.text, r.markup);
}

// ───────────────────────── generic ─────────────────────────

async function cancel(c: Ctx): Promise<void> {
  const ok = await cancelJob(c.deps, c.job);
  await c.answer(ok ? c.m.cancelledAlert : undefined);
}

async function retry(c: Ctx): Promise<void> {
  const ok = await retryJob(c.deps, c.job);
  await c.answer(ok ? c.m.started : undefined, !ok);
}

async function close(c: Ctx): Promise<void> {
  const { deps, job } = c;
  if (job.status === "ready") await transition(deps.db, job.id, "ready", "expired", deps.now(), {}, "closed by user");
  if (c.cq.message) await deps.tg.deleteMessage(c.cq.message.chat.id, c.cq.message.message_id);
  await c.answer();
}

async function historyDetail(c: Ctx): Promise<void> {
  const { deps, job, m } = c;
  const sel = jobSelection(job);
  const result = jobResult(job);
  await deps.tg.sendMessage(job.chat_id, m.historyDetail({
    id: job.id,
    site: job.site,
    title: job.title,
    label: sel?.label ?? null,
    status: `${m.statusIcons[job.status] ?? ""} ${job.status}`,
    created: formatDate(job.created_at),
    finished: job.finished_at ? formatDate(job.finished_at) : null,
    delivery: job.delivery_mode,
    size: result?.sizeBytes ?? null,
    error: job.error_code,
    url: job.source_url,
  }));
  await c.answer();
}

async function pickPlaylistEntry(c: Ctx): Promise<void> {
  const { deps, job, m, user } = c;
  let entries: { url: string }[] = [];
  try {
    entries = (JSON.parse(job.metadata_json ?? "{}") as { playlist?: { entries: { url: string }[] } }).playlist?.entries ?? [];
  } catch {
    /* fall through */
  }
  const index = Number(c.arg);
  const entry = entries[index];
  if (job.status !== "ready" || !entry) return c.answer(m.menuExpired, true);
  await c.answer(m.inspecting);
  await transition(deps.db, job.id, "ready", "expired", deps.now(), {}, "playlist entry chosen");
  if (c.cq.message) await deps.tg.deleteMessage(c.cq.message.chat.id, c.cq.message.message_id);
  await submitUrl(deps, user, m, job.chat_id, undefined, entry.url);
}

// ───────────────────────── quality ─────────────────────────

async function pickQuality(c: Ctx): Promise<void> {
  const { deps, job, m, settings } = c;
  const info = jobMetadata(job);
  const option = findOption(jobOptions(job), c.arg ?? "");
  if (!info || !option) return c.answer(m.menuExpired, true);
  const previous = currentDraft(job);
  const { draft, decision } = buildDraft({ info, option, settings, cfg: deps.cfg, previous });
  if (!decision.mode) return c.answer(m.rejectedAlert(explainRejection(decision)), true);
  await saveDraft(c, draft);
  if (settings.quickStart) {
    const started = await startFromDraft(deps, c.user, m, c.job, draft);
    return c.answer(started.ok ? m.started : m.startRejected(started.reason).replace(/<[^>]+>/g, ""), !started.ok);
  }
  await renderCustomizeScreen(c, draft);
  await c.answer();
}

async function showAdvanced(c: Ctx): Promise<void> {
  const page = Number(c.arg ?? 0) || 0;
  const r = await renderAdvanced(c.deps, c.job, page);
  await editMenu(c.deps, c.job, r.text, r.markup);
  await c.answer();
}

async function showAudioTracks(c: Ctx): Promise<void> {
  await editMenu(c.deps, c.job, c.m.audioTracksTitle, audioTracksKeyboard(c.m, c.job, jobOptions(c.job)));
  await c.answer();
}

async function backToMenu(c: Ctx): Promise<void> {
  const rendered = renderQualityMenu(c.deps, c.m, c.job, c.settings);
  if (!rendered) return c.answer(c.m.menuExpired, true);
  await editMenu(c.deps, c.job, rendered.text, rendered.markup);
  await c.answer();
}

async function showCustomize(c: Ctx): Promise<void> {
  const draft = await ensureDraft(c);
  if (!draft) return c.answer(c.m.menuExpired, true);
  await renderCustomizeScreen(c, draft);
  await c.answer();
}

async function go(c: Ctx): Promise<void> {
  const draft = currentDraft(c.job);
  if (!draft) return c.answer(c.m.nothingSelected, true);
  const started = await startFromDraft(c.deps, c.user, c.m, c.job, draft);
  await c.answer(started.ok ? c.m.started : c.m.startRejected(started.reason).replace(/<[^>]+>/g, ""), !started.ok);
}

// ───────────────────────── thumbnail ─────────────────────────

async function showThumbnails(c: Ctx): Promise<void> {
  const draft = await ensureDraft(c);
  if (!draft) return c.answer(c.m.menuExpired, true);
  await editMenu(c.deps, c.job, c.m.thumbMenu, thumbnailKeyboard(c.m, c.job, draft));
  await c.answer();
}

async function setThumbnailMode(c: Ctx): Promise<void> {
  const draft = await ensureDraft(c);
  const mode = c.arg;
  if (!draft || (mode !== "original" && mode !== "frame" && mode !== "none")) return c.answer(c.m.menuExpired, true);
  const next: Draft = { ...draft, thumbnail: { mode } };
  await saveDraft(c, next);
  await editMenu(c.deps, c.job, c.m.thumbMenu, thumbnailKeyboard(c.m, c.job, next));
  await c.answer(c.m.thumbSet(c.m.thumbOptions[mode].replace(/^\S+\s/, "")));
}

async function askThumbnailUpload(c: Ctx): Promise<void> {
  await setUserState(c.deps.db, c.user.tg_user_id, { kind: "await_thumbnail", jobShortId: c.job.short_id }, c.deps.now());
  await c.deps.tg.sendMessage(c.job.chat_id, c.m.askThumbnail);
  await c.answer();
}

async function previewFrames(c: Ctx): Promise<void> {
  const draft = await ensureDraft(c);
  if (!draft?.videoFormatId) return c.answer(c.m.framesFailed("no video stream"), true);
  await c.deps.tg.sendChatAction(c.job.chat_id, "upload_photo");
  await c.deps.tg.sendMessage(c.job.chat_id, c.m.framesLoading);
  await c.deps.queue.send({ type: "frames", jobId: c.job.id, correlationId: c.job.correlation_id });
  await c.answer();
}

async function chooseFrame(c: Ctx): Promise<void> {
  const draft = await ensureDraft(c);
  const index = Number(c.arg);
  const timestamp = draft?.frameChoices?.[index];
  if (!draft || timestamp === undefined) return c.answer(c.m.menuExpired, true);
  const next: Draft = { ...draft, thumbnail: { mode: "frame", frameTimestamp: timestamp } };
  await saveDraft(c, next);
  await renderCustomizeScreen(c, next);
  await c.answer(c.m.thumbSet(c.m.thumbOptions.frame.replace(/^\S+\s/, "")));
}

/** Queue consumer for `frames` messages (frame extraction can take a while). */
export async function runFramePreview(deps: Deps, jobId: string): Promise<void> {
  const job = await getJob(deps.db, jobId);
  if (!job || job.status !== "ready") return;
  const { m } = await messagesFor(deps, job.user_id);
  const draft = currentDraft(job);
  const info = jobMetadata(job);
  if (!draft?.videoFormatId || !info) return;
  try {
    const outcome = await deps.backend.frames(job.id, job.source_url, draft.videoFormatId, info.durationSeconds, 5);
    if (!outcome.ok) {
      await deps.tg.sendMessage(job.chat_id, m.framesFailed(outcome.error.message));
      return;
    }
    const photos = outcome.frames.map((f, i) => ({
      bytes: Uint8Array.from(atob(f.jpegBase64), (ch) => ch.charCodeAt(0)),
      caption: m.framesCaption(i + 1, f.timestamp),
    }));
    await deps.tg.sendPhotoAlbum(job.chat_id, photos);
    const next: Draft = { ...draft, frameChoices: outcome.frames.map((f) => f.timestamp) };
    await patchJob(deps.db, job.id, { selection_json: JSON.stringify(next) }, deps.now());
    await deps.tg.sendMessage(job.chat_id, m.framesPick, { reply_markup: framesKeyboard(m, job, photos.length) });
  } catch (error) {
    deps.log.warn("frame preview failed", { jobId: job.id, error });
    await deps.tg.sendMessage(job.chat_id, m.framesFailed(error instanceof Error ? error.message : "error"));
  }
}

// ───────────────────────── text fields ─────────────────────────

const EDIT_FIELDS: Record<string, "await_title" | "await_filename" | "await_caption" | "await_embed_title" | "await_embed_artist"> = {
  title: "await_title",
  file: "await_filename",
  cap: "await_caption",
  etitle: "await_embed_title",
  eart: "await_embed_artist",
};

async function askEdit(c: Ctx): Promise<void> {
  const draft = await ensureDraft(c);
  const kind = EDIT_FIELDS[c.arg ?? ""];
  if (!draft || !kind) return c.answer(c.m.menuExpired, true);
  await setUserState(c.deps.db, c.user.tg_user_id, { kind, jobShortId: c.job.short_id }, c.deps.now());
  const prompt = {
    await_title: c.m.askTitle(draft.title),
    await_filename: c.m.askFilename(draft.filename),
    await_caption: c.m.askCaption(draft.caption.replace(/<[^>]+>/g, "")),
    await_embed_title: c.m.askEmbedTitle,
    await_embed_artist: c.m.askEmbedArtist,
  }[kind];
  await c.deps.tg.sendMessage(c.job.chat_id, prompt);
  await c.answer();
}

async function clearMetadata(c: Ctx): Promise<void> {
  const draft = await ensureDraft(c);
  if (!draft) return c.answer(c.m.menuExpired, true);
  const next: Draft = { ...draft, embedTitle: null, embedArtist: null };
  await saveDraft(c, next);
  await renderCustomizeScreen(c, next);
  await c.answer(c.m.valueSaved);
}

// ───────────────────────── container / delivery / send-as ─────────────────────────

async function renderContainers(c: Ctx, draft: Draft): Promise<void> {
  const compat = draft.kind === "video" && draft.container !== "original" ? containerCompat(draft.videoCodec, draft.audioCodec, draft.container) : { ok: true as const };
  const note = !compat.ok && !draft.allowTranscode ? (compat.reason ?? null) : null;
  await editMenu(c.deps, c.job, c.m.containerMenu(note), containerKeyboard(c.m, c.job, draft, containerChoices(draft.kind)));
}

async function showContainers(c: Ctx): Promise<void> {
  const draft = await ensureDraft(c);
  if (!draft) return c.answer(c.m.menuExpired, true);
  await renderContainers(c, draft);
  await c.answer();
}

async function setContainer(c: Ctx): Promise<void> {
  const draft = await ensureDraft(c);
  const arg = c.arg;
  if (!draft || !arg || !containerChoices(draft.kind).includes(arg as never)) return c.answer(c.m.menuExpired, true);
  const container = arg === "auto" ? resolveContainer("auto", draft.videoCodec, draft.audioCodec) : (arg as Draft["container"]);
  const next: Draft = { ...draft, container };
  await saveDraft(c, next);
  await renderContainers(c, next);
  await c.answer();
}

async function toggleTranscode(c: Ctx): Promise<void> {
  const draft = await ensureDraft(c);
  if (!draft) return c.answer(c.m.menuExpired, true);
  const next: Draft = { ...draft, allowTranscode: !draft.allowTranscode };
  await saveDraft(c, next);
  await renderContainers(c, next);
  await c.answer();
}

async function showDelivery(c: Ctx): Promise<void> {
  const draft = await ensureDraft(c);
  if (!draft) return c.answer(c.m.menuExpired, true);
  const cfg = c.deps.cfg;
  await editMenu(c.deps, c.job, c.m.deliveryMenu({ cloud: formatBytes(cfg.cloudUploadLimitBytes), mtproto: cfg.mtprotoEnabled ? formatBytes(cfg.mtprotoUploadLimitBytes) : null, local: cfg.localBotApiEnabled ? formatBytes(cfg.localUploadLimitBytes) : null }), deliveryKeyboard(c.m, c.job, draft.deliveryPref, cfg));
  await c.answer();
}

async function setDelivery(c: Ctx): Promise<void> {
  const draft = await ensureDraft(c);
  const map = { auto: "auto", cloud: "bot_api_cloud", mtproto: "mtproto", local: "bot_api_local", link: "r2_link" } as const;
  const pref = map[(c.arg ?? "") as keyof typeof map];
  if (!draft || !pref) return c.answer(c.m.menuExpired, true);
  if (pref === "bot_api_local" && !c.deps.cfg.localBotApiEnabled) return c.answer(c.m.deliveryLabels.bot_api_local + " ✖", true);
  if (pref === "mtproto" && !c.deps.cfg.mtprotoEnabled) return c.answer(c.m.deliveryLabels.mtproto + " ✖", true);
  if (pref === "r2_link" && !c.deps.cfg.linkDeliveryEnabled) return c.answer(c.m.deliveryLabels.r2_link + " ✖ (R2 / PUBLIC_BASE_URL)", true);
  const { draft: next, decision } = reevaluate({ ...draft, deliveryPref: pref }, true, c.deps.cfg);
  await saveDraft(c, next);
  const cfg = c.deps.cfg;
  await editMenu(c.deps, c.job, c.m.deliveryMenu({ cloud: formatBytes(cfg.cloudUploadLimitBytes), mtproto: cfg.mtprotoEnabled ? formatBytes(cfg.mtprotoUploadLimitBytes) : null, local: cfg.localBotApiEnabled ? formatBytes(cfg.localUploadLimitBytes) : null }), deliveryKeyboard(c.m, c.job, pref, cfg));
  await c.answer(decision.mode ? undefined : c.m.rejectedAlert(explainRejection(decision)), !decision.mode);
}

async function toggleSendAs(c: Ctx): Promise<void> {
  const draft = await ensureDraft(c);
  if (!draft) return c.answer(c.m.menuExpired, true);
  const next: Draft = { ...draft, sendAs: draft.sendAs === "document" ? "auto" : "document" };
  await saveDraft(c, next);
  await renderCustomizeScreen(c, next);
  await c.answer();
}
