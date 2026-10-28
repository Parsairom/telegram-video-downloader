/** The interactive menu message of a job: quality list, advanced formats, customise screens. */
import type { InspectResult } from "@tvd/shared-types";
import type { Deps } from "../app";
import type { Messages, MenuData } from "../bot/i18n";
import { formatUploadDate } from "../bot/format";
import type { InlineKeyboard } from "../bot/telegram";
import { TelegramError } from "../bot/telegram";
import { getJob, jobMetadata, jobOptions, jobSelection, patchJob } from "../db/jobs";
import type { JobRow, UserSettings } from "../db/types";
import { advancedKeyboard, customizeKeyboard, qualityKeyboard } from "../keyboards";
import { bestWithin, type OptionsBundle } from "./formats";
import { messagesFor } from "./progress";
import { type Draft, reevaluate } from "./selection";
import { decideDelivery } from "./size-policy";

const CAPTION_LIMIT = 1024;

export function buildMenuData(info: InspectResult, bundle: OptionsBundle, decide: (o: OptionsBundle["quick"][number]) => ReturnType<typeof decideDelivery>): MenuData {
  const videos = bundle.quick.filter((o) => o.kind === "video");
  return {
    title: info.title,
    site: info.site,
    duration: info.durationSeconds,
    uploader: info.uploader,
    uploadDate: formatUploadDate(info.uploadDate),
    lines: videos.map((o) => ({ label: o.label, size: o.estimatedBytes, approx: o.estimateIsApprox, badge: decide(o).badge })),
    hasAudio: bundle.quick.some((o) => o.kind === "audio"),
  };
}

export function renderQualityMenu(deps: Deps, m: Messages, job: JobRow, settings: UserSettings): { text: string; markup: InlineKeyboard } | null {
  const info = jobMetadata(job);
  if (!info) return null;
  const bundle = jobOptions(job);
  const decide = (o: OptionsBundle["quick"][number]) => decideDelivery(o.estimatedBytes, o.estimateIsApprox, deps.cfg, settings.deliveryPreference);
  const best = bestWithin(bundle, deps.cfg.maxOutputBytes);
  let text = m.menuCaption(buildMenuData(info, bundle, decide));
  if (text.length > CAPTION_LIMIT) {
    // shorten the long title until the caption fits Telegram's limit (the legend must stay intact)
    const data = buildMenuData(info, bundle, decide);
    for (const limit of [120, 80, 50, 30]) {
      text = m.menuCaption({ ...data, title: data.title.slice(0, limit), uploader: null });
      if (text.length <= CAPTION_LIMIT) break;
    }
  }
  return { text, markup: qualityKeyboard(m, job, bundle, decide, best?.key ?? null) };
}

/** Send the quality menu (cover photo + caption when the site has a cover, text otherwise). */
export async function showQualityMenu(deps: Deps, job: JobRow): Promise<void> {
  const { m, settings } = await messagesFor(deps, job.user_id);
  const rendered = renderQualityMenu(deps, m, job, settings);
  if (!rendered) return;
  const info = jobMetadata(job);
  let messageId: number | null = null;
  let isPhoto = 0;
  if (info?.thumbnail && /^https?:\/\//.test(info.thumbnail)) {
    try {
      const sent = await deps.tg.sendPhoto(job.chat_id, info.thumbnail, rendered.text, { reply_markup: rendered.markup });
      messageId = sent.message_id;
      isPhoto = 1;
    } catch (error) {
      // Telegram could not fetch/accept the cover (size, type, hotlink protection): fall back to plain text
      deps.log.info("cover photo rejected, sending text menu", { jobId: job.id, error: error instanceof TelegramError ? error.description : String(error) });
    }
  }
  if (messageId === null) {
    const sent = await deps.tg.sendMessage(job.chat_id, rendered.text, { reply_markup: rendered.markup });
    messageId = sent.message_id;
  }
  await patchJob(deps.db, job.id, { menu_message_id: messageId, menu_is_photo: isPhoto }, deps.now());
}

/** Replace the text + keyboard of the menu message in place (caption for photos). */
export async function editMenu(deps: Deps, job: JobRow, text: string, markup: InlineKeyboard): Promise<void> {
  if (!job.menu_message_id) return;
  try {
    if (job.menu_is_photo) await deps.tg.editMessageCaption(job.chat_id, job.menu_message_id, text.slice(0, CAPTION_LIMIT), markup);
    else await deps.tg.editMessageText(job.chat_id, job.menu_message_id, text, markup);
  } catch (error) {
    if (error instanceof TelegramError && error.isNotModified) return;
    throw error;
  }
}

export async function removeMenuKeyboard(deps: Deps, job: JobRow): Promise<void> {
  if (!job.menu_message_id) return;
  try {
    await deps.tg.editReplyMarkup(job.chat_id, job.menu_message_id, { inline_keyboard: [] });
  } catch (error) {
    deps.log.debug("could not clear menu keyboard", { jobId: job.id, error });
  }
}

export async function renderCustomize(deps: Deps, job: JobRow, draft: Draft): Promise<{ text: string; markup: InlineKeyboard }> {
  const { m } = await messagesFor(deps, job.user_id);
  const bundle = jobOptions(job);
  const option = [...bundle.quick, ...bundle.advanced, ...bundle.audioTracks].find((o) => o.key === draft.optionKey);
  const { draft: current, decision } = reevaluate(draft, option?.estimateIsApprox ?? false, deps.cfg);
  const text = m.customizeText({
    label: current.label,
    title: current.title,
    filename: current.filename,
    caption: current.caption,
    container: current.container,
    thumbnail: current.thumbnail.mode,
    delivery: current.deliveryMode,
    badge: decision.badge,
    sendAs: current.sendAs,
    embedTitle: current.embedTitle,
    embedArtist: current.embedArtist,
    estimatedBytes: current.estimatedBytes,
    transcode: current.allowTranscode,
  });
  return { text, markup: customizeKeyboard(m, job, current) };
}

export async function renderAdvanced(deps: Deps, job: JobRow, page: number): Promise<{ text: string; markup: InlineKeyboard }> {
  const { m } = await messagesFor(deps, job.user_id);
  const { keyboard, pages, page: p } = advancedKeyboard(m, job, jobOptions(job), page);
  return { text: m.advancedTitle(p + 1, pages), markup: keyboard };
}

export async function reloadJob(deps: Deps, jobId: string): Promise<JobRow | null> {
  return getJob(deps.db, jobId);
}

export function currentDraft(job: JobRow): Draft | null {
  return jobSelection(job) as Draft | null;
}
