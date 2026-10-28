/** Builds and edits the job "draft" selection: quality + container + thumbnail + names + delivery. */
import type { InspectResult, JobSelection, OutputContainer, QualityOption } from "@tvd/shared-types";
import type { Config } from "../config";
import { escapeHtml, sanitizeFilename } from "../bot/format";
import type { UserSettings } from "../db/types";
import { containerCompat, resolveContainer } from "./formats";
import { decideDelivery, type DeliveryDecision, type DeliveryPreference } from "./size-policy";

/** Worker-side draft = the selection sent to the container plus the user's un-resolved choices. */
export interface Draft extends JobSelection {
  optionKey: string;
  /** the user's delivery choice (may be "auto"); `deliveryMode` is what it resolves to for the current size */
  deliveryPref: DeliveryPreference;
  /** timestamps (seconds) of the preview frames currently offered for the thumbnail */
  frameChoices?: number[];
}

export const DEFAULT_CAPTION = "<b>{title}</b>\n\n📺 {resolution} · ⏱ {duration} · 📦 {size}\n🌐 {site}\n🔗 {url}";
export const DEFAULT_AUDIO_CAPTION = "<b>{title}</b>\n\n🎧 MP3 · ⏱ {duration} · 📦 {size}\n🌐 {site}\n🔗 {url}";

export function captionFromUserText(text: string): string {
  // user text is escaped; {placeholders} survive because braces are not HTML-special
  return escapeHtml(text).slice(0, 900);
}

export function buildDraft(args: {
  info: InspectResult;
  option: QualityOption;
  settings: UserSettings;
  cfg: Config;
  previous?: Draft | null;
}): { draft: Draft; decision: DeliveryDecision } {
  const { info, option, settings, cfg, previous } = args;
  const isAudio = option.kind === "audio";

  let container: OutputContainer;
  if (isAudio) {
    container = previous?.kind === "audio" && previous.container !== "original" ? previous.container : "mp3";
  } else if (previous && previous.kind === "video" && previous.container !== "original" && previous.optionKey !== option.key) {
    // keep the user's explicit container choice across quality switches when it still works
    container = containerCompat(option.vcodec, option.acodec, previous.container).ok || previous.allowTranscode ? previous.container : resolveContainer("auto", option.vcodec, option.acodec);
  } else {
    const resolved = resolveContainer(settings.defaultContainer, option.vcodec, option.acodec);
    container = containerCompat(option.vcodec, option.acodec, resolved).ok ? resolved : "original";
  }

  const baseName = sanitizeFilename(previous?.title && previous.title !== info.title ? previous.title : info.title) || "video";
  const deliveryPref: DeliveryPreference = previous?.deliveryPref ?? settings.deliveryPreference;
  const decision = decideDelivery(option.estimatedBytes, option.estimateIsApprox, cfg, deliveryPref);

  const customCaption = previous && previous.caption !== DEFAULT_CAPTION && previous.caption !== DEFAULT_AUDIO_CAPTION ? previous.caption : null;
  const userCaption = settings.defaultCaption ? captionFromUserText(settings.defaultCaption) : null;

  const draft: Draft = {
    optionKey: option.key,
    deliveryPref,
    kind: option.kind,
    videoFormatId: option.videoFormatId,
    audioFormatId: option.audioFormatId,
    videoCodec: option.vcodec,
    audioCodec: option.acodec,
    label: option.label,
    container,
    title: previous?.title ?? info.title,
    filename: previous?.filename ?? baseName,
    caption: customCaption ?? userCaption ?? (isAudio ? DEFAULT_AUDIO_CAPTION : DEFAULT_CAPTION),
    embedTitle: previous ? previous.embedTitle : settings.embedMetadata ? info.title : null,
    embedArtist: previous ? previous.embedArtist : settings.embedMetadata ? info.uploader : null,
    thumbnail: previous?.thumbnail ?? { mode: settings.thumbnailMode },
    deliveryMode: decision.mode ?? "r2_link",
    sendAs: previous?.sendAs ?? (settings.sendAs === "document" ? "document" : "auto"),
    estimatedBytes: option.estimatedBytes,
    expectedHeight: option.height,
    allowTranscode: previous?.allowTranscode ?? false,
    allowLinkFallback: decision.allowLinkFallback,
  };
  return { draft, decision };
}

/** Re-evaluate delivery for the draft (size, preference or operator policy may have changed). */
export function reevaluate(draft: Draft, approx: boolean, cfg: Config): { draft: Draft; decision: DeliveryDecision } {
  const decision = decideDelivery(draft.estimatedBytes, approx, cfg, draft.deliveryPref);
  return { draft: { ...draft, deliveryMode: decision.mode ?? "r2_link", allowLinkFallback: decision.allowLinkFallback }, decision };
}

/** The selection exactly as the container expects it (draft-only fields stripped). */
export function toSelection(draft: Draft): JobSelection {
  const { optionKey: _o, deliveryPref: _d, frameChoices: _f, ...selection } = draft;
  return selection;
}

export function containerChoices(kind: "video" | "audio"): ("auto" | "mp4" | "webm" | "original" | "mkv" | "mp3" | "m4a")[] {
  return kind === "audio" ? ["mp3", "m4a", "original"] : ["auto", "mp4", "webm", "mkv", "original"];
}
