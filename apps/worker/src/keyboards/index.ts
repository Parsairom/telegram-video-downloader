import type { JobSelection, QualityOption } from "@tvd/shared-types";
import type { Config } from "../config";
import { encodeAdmin, encodeHistory, encodeJob, encodeSetting } from "../callbacks/codec";
import type { InlineButton, InlineKeyboard, ReplyKeyboard } from "../bot/telegram";
import type { Messages } from "../bot/i18n";
import { formatBytes } from "../bot/format";
import type { JobRow, UserSettings } from "../db/types";
import type { OptionsBundle } from "../services/formats";
import { containerCompat, describeOption } from "../services/formats";
import type { DeliveryDecision } from "../services/size-policy";

const btn = (text: string, data: string): InlineButton => ({ text, callback_data: data });
const chunk = <T>(items: T[], size: number): T[][] => {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
};

export function mainMenu(m: Messages): ReplyKeyboard {
  return {
    keyboard: [[{ text: m.labels.download }], [{ text: m.labels.settings }, { text: m.labels.history }], [{ text: m.labels.help }, { text: m.labels.account }]],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: m.lang === "fa" ? "لینک ویدیو رو اینجا بفرست…" : "Paste a video link…",
  };
}

export type DecideFor = (o: QualityOption) => DeliveryDecision;

export function qualityKeyboard(m: Messages, job: JobRow, bundle: OptionsBundle, decide: DecideFor, bestKey: string | null): InlineKeyboard {
  const rows: InlineButton[][] = [];
  const videos = bundle.quick.filter((o) => o.kind === "video");
  const audio = bundle.quick.find((o) => o.kind === "audio");
  if (bestKey && videos.length > 1) rows.push([btn(m.btnBest, encodeJob("q", job.short_id, bestKey))]);
  const buttons = videos.map((o) => {
    const d = decide(o);
    // a rejected option still renders (so the user sees why) but answers with an alert instead of starting
    return btn(m.btnQuality(o.label, o.estimatedBytes, o.estimateIsApprox, d.badge), encodeJob("q", job.short_id, o.key));
  });
  rows.push(...chunk(buttons, 2));
  if (audio) rows.push([btn(m.btnAudio(audio.estimatedBytes), encodeJob("q", job.short_id, audio.key))]);
  const extra: InlineButton[] = [];
  if (bundle.advanced.length > videos.length) extra.push(btn(m.btnAdvanced, encodeJob("qa", job.short_id, 0)));
  if (bundle.audioTracks.length > 1) extra.push(btn(m.btnAudioTracks, encodeJob("qt", job.short_id)));
  if (extra.length) rows.push(extra);
  rows.push([btn(m.btnCustomize, encodeJob("cu", job.short_id)), btn(m.btnClose, encodeJob("cl", job.short_id))]);
  return { inline_keyboard: rows };
}

export const ADVANCED_PAGE_SIZE = 6;

export function advancedKeyboard(m: Messages, job: JobRow, bundle: OptionsBundle, page: number): { keyboard: InlineKeyboard; pages: number; page: number } {
  const pages = Math.max(1, Math.ceil(bundle.advanced.length / ADVANCED_PAGE_SIZE));
  const p = Math.min(Math.max(page, 0), pages - 1);
  const slice = bundle.advanced.slice(p * ADVANCED_PAGE_SIZE, (p + 1) * ADVANCED_PAGE_SIZE);
  const rows = slice.map((o) => [btn(`${describeOption(o)}${o.estimatedBytes ? ` · ${o.estimateIsApprox ? "≈" : ""}${formatBytes(o.estimatedBytes)}` : ""}`, encodeJob("q", job.short_id, o.key))]);
  const nav: InlineButton[] = [];
  if (p > 0) nav.push(btn(m.btnPrev, encodeJob("qa", job.short_id, p - 1)));
  if (p < pages - 1) nav.push(btn(m.btnNext, encodeJob("qa", job.short_id, p + 1)));
  if (nav.length) rows.push(nav);
  rows.push([btn(m.btnBack, encodeJob("bk", job.short_id))]);
  return { keyboard: { inline_keyboard: rows }, pages, page: p };
}

export function audioTracksKeyboard(m: Messages, job: JobRow, bundle: OptionsBundle): InlineKeyboard {
  const rows = bundle.audioTracks.map((o) => [btn(`🎵 ${o.label}${o.estimatedBytes ? ` · ≈${formatBytes(o.estimatedBytes)}` : ""}`, encodeJob("q", job.short_id, o.key))]);
  rows.push([btn(m.btnBack, encodeJob("bk", job.short_id))]);
  return { inline_keyboard: rows };
}

export function customizeKeyboard(m: Messages, job: JobRow, sel: JobSelection): InlineKeyboard {
  const id = job.short_id;
  const rows: InlineButton[][] = [
    [btn(m.btnTitle, encodeJob("ed", id, "title")), btn(m.btnFilename, encodeJob("ed", id, "file"))],
    [btn(m.btnCaption, encodeJob("ed", id, "cap")), btn(m.btnMetadata, encodeJob("ed", id, "etitle"))],
    [btn(m.btnThumbnail, encodeJob("th", id)), btn(m.btnContainer, encodeJob("ct", id))],
    [btn(m.btnDelivery, encodeJob("dm", id)), btn(m.btnSendAs(sel.sendAs), encodeJob("sa", id))],
  ];
  if (sel.embedTitle || sel.embedArtist) rows.push([btn(m.lang === "fa" ? "🧹 حذف متادیتای سفارشی" : "🧹 Clear custom metadata", encodeJob("ed0", id))]);
  rows.push([btn(m.btnStart, encodeJob("go", id))], [btn(m.btnBack, encodeJob("bk", id)), btn(m.btnCancel, encodeJob("cx", id))]);
  return { inline_keyboard: rows };
}

export function thumbnailKeyboard(m: Messages, job: JobRow, sel: JobSelection): InlineKeyboard {
  const id = job.short_id;
  const mark = (mode: string, label: string) => `${sel.thumbnail.mode === mode ? "✔ " : ""}${label}`;
  return {
    inline_keyboard: [
      [btn(mark("original", m.thumbOptions.original), encodeJob("ths", id, "original"))],
      [btn(mark("frame", m.thumbOptions.frame), encodeJob("ths", id, "frame")), btn(m.thumbOptions.preview, encodeJob("thp", id))],
      [btn(mark("custom", m.thumbOptions.upload), encodeJob("thu", id))],
      [btn(mark("none", m.thumbOptions.none), encodeJob("ths", id, "none"))],
      [btn(m.btnBack, encodeJob("cu", id))],
    ],
  };
}

export function framesKeyboard(m: Messages, job: JobRow, count: number): InlineKeyboard {
  const numbers = Array.from({ length: count }, (_, i) => btn(String(i + 1), encodeJob("thf", job.short_id, i)));
  return { inline_keyboard: [numbers, [btn(m.btnBack, encodeJob("th", job.short_id))]] };
}

export function containerKeyboard(m: Messages, job: JobRow, sel: JobSelection, choices: ("auto" | "mp4" | "webm" | "original" | "mkv" | "mp3" | "m4a")[]): InlineKeyboard {
  const rows: InlineButton[][] = chunk(
    choices.map((c) => {
      const resolved = c === "auto" ? null : c;
      const compat = resolved ? containerCompat(sel.videoCodec, sel.audioCodec, resolved) : { ok: true };
      const label = m.containerLabels[c] ?? c;
      return btn(`${sel.container === c ? "✔ " : ""}${compat.ok ? label : m.containerNeedsTranscode(label)}`, encodeJob("cts", job.short_id, c));
    }),
    2,
  );
  rows.push([btn(m.transcodeToggle(sel.allowTranscode), encodeJob("tc", job.short_id))]);
  rows.push([btn(m.btnBack, encodeJob("cu", job.short_id))]);
  return { inline_keyboard: rows };
}

export function deliveryKeyboard(m: Messages, job: JobRow, current: string, cfg: Pick<Config, "localBotApiEnabled" | "mtprotoEnabled" | "linkDeliveryEnabled">): InlineKeyboard {
  const modes: [string, string][] = [
    ["auto", "auto"],
    ["cloud", "bot_api_cloud"],
    ...(cfg.mtprotoEnabled ? ([["mtproto", "mtproto"]] as [string, string][]) : []),
    ...(cfg.localBotApiEnabled ? ([["local", "bot_api_local"]] as [string, string][]) : []),
    ...(cfg.linkDeliveryEnabled ? ([["link", "r2_link"]] as [string, string][]) : []),
  ];
  const rows = modes.map(([arg, key]) => [btn(`${current === key || (current === "auto" && arg === "auto") ? "✔ " : ""}${m.deliveryLabels[key]}`, encodeJob("dms", job.short_id, arg))]);
  rows.push([btn(m.btnBack, encodeJob("cu", job.short_id))]);
  return { inline_keyboard: rows };
}

export function cancelKeyboard(m: Messages, job: Pick<JobRow, "short_id">): InlineKeyboard {
  return { inline_keyboard: [[btn(m.btnCancel, encodeJob("cx", job.short_id))]] };
}

export function retryKeyboard(m: Messages, job: Pick<JobRow, "short_id">): InlineKeyboard {
  return { inline_keyboard: [[btn(m.btnRetry, encodeJob("rt", job.short_id))]] };
}

export function playlistKeyboard(m: Messages, job: JobRow, entries: { title: string; durationSeconds: number | null }[]): InlineKeyboard {
  const rows = entries.map((e, i) => [btn(`${i + 1}. ${e.title.slice(0, 46)}`, encodeJob("pl", job.short_id, i))]);
  rows.push([btn(m.btnClose, encodeJob("cl", job.short_id))]);
  return { inline_keyboard: rows };
}

export function settingsKeyboard(m: Messages, s: UserSettings, language: string, _cfg: Pick<Config, "localBotApiEnabled" | "mtprotoEnabled" | "linkDeliveryEnabled">): InlineKeyboard {
  const L = m.settingLabels;
  return {
    inline_keyboard: [
      [btn(L.resolution(s.defaultResolution), encodeSetting("res", "next"))],
      [btn(L.container(s.defaultContainer), encodeSetting("cont", "next"))],
      [btn(L.quickStart(s.quickStart), encodeSetting("quick", "toggle"))],
      [btn(L.thumbnail(s.thumbnailMode), encodeSetting("thumb", "next"))],
      [btn(L.delivery(s.deliveryPreference), encodeSetting("deliv", "next"))],
      [btn(L.sendAs(s.sendAs), encodeSetting("sendas", "toggle"))],
      [btn(L.caption(s.defaultCaption), encodeSetting("cap", "edit"))],
      [btn(L.progress(s.progressUpdates), encodeSetting("prog", "toggle"))],
      [btn(L.embed(s.embedMetadata), encodeSetting("embed", "toggle"))],
      [btn(language === "en" ? L.language : m.settingLabels.language, encodeSetting("lang", "toggle"))],
    ],
  };
}

export function historyKeyboard(m: Messages, jobs: JobRow[], page: number, pages: number): InlineKeyboard {
  const rows: InlineButton[][] = chunk(jobs.map((j, i) => btn(String(page * jobs.length + i + 1 > 0 ? i + 1 : i + 1), encodeJob("hd", j.short_id))), 5);
  const nav: InlineButton[] = [];
  if (page > 0) nav.push(btn(m.btnPrev, encodeHistory("page", page - 1)));
  if (page < pages - 1) nav.push(btn(m.btnNext, encodeHistory("page", page + 1)));
  if (nav.length) rows.push(nav);
  rows.push([btn(m.btnClearHistory, encodeHistory("clear"))]);
  return { inline_keyboard: rows };
}

export function confirmClearKeyboard(m: Messages): InlineKeyboard {
  return { inline_keyboard: [[btn(m.btnConfirmYes, encodeHistory("clear_yes")), btn(m.btnBack, encodeHistory("page", 0))]] };
}

export function adminKeyboard(): InlineKeyboard {
  return {
    inline_keyboard: [
      [btn("📊 stats", encodeAdmin("stats")), btn("🟢 active", encodeAdmin("active"))],
      [btn("❌ failed", encodeAdmin("failed")), btn("🩺 health", encodeAdmin("health"))],
      [btn("🎚 limits", encodeAdmin("limits")), btn("🧹 cleanup", encodeAdmin("cleanup"))],
    ],
  };
}

export function announceConfirmKeyboard(token: string): InlineKeyboard {
  return { inline_keyboard: [[btn("✅ send to all", encodeAdmin("annyes", token)), btn("✖️ cancel", encodeAdmin("anncancel", token))]] };
}
