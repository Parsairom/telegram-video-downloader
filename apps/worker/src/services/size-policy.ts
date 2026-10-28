/**
 * File-size policy. Sizes are always bytes. The ceilings must not be confused:
 *   - maxOutputBytes       application ceiling (default 1.9 GB) — what we are willing to download at all
 *   - cloud limit          what the standard Bot API can upload (50 MB)
 *   - mtproto limit        what an MTProto upload by the bot can carry (2000 MB) — needs API credentials on the engine
 *   - local limit          what a self-hosted Bot API server can upload (2000 MB, experimental)
 *   - link delivery        bounded only by maxOutputBytes; needs R2 + PUBLIC_BASE_URL
 * R2 storage capacity is irrelevant to Telegram delivery capacity.
 */
import type { DeliveryMode } from "@tvd/shared-types";
import type { Config } from "../config";

export type DeliveryPreference = "auto" | DeliveryMode;

export interface DeliveryDecision {
  mode: DeliveryMode | null;
  /** the container may switch to a bigger mechanism / a link if the finished file turns out too big for `mode` */
  allowLinkFallback: boolean;
  /** why the choice is refused, when mode === null */
  rejected: "exceeds_max" | "exceeds_mode" | "mode_unavailable" | null;
  /** UI hint: will the user receive the file in Telegram ("direct") or a link ("link")? */
  badge: "direct" | "link" | "rejected";
}

type PolicyConfig = Pick<
  Config,
  | "maxOutputBytes"
  | "cloudUploadLimitBytes"
  | "localUploadLimitBytes"
  | "mtprotoUploadLimitBytes"
  | "localBotApiEnabled"
  | "mtprotoEnabled"
  | "linkDeliveryEnabled"
  | "deliveryPolicy"
>;

const UNCERTAIN_MARGIN = 1.1; // estimates (bitrate × duration) can be ~10% off

export function decideDelivery(sizeBytes: number | null, approx: boolean, cfg: PolicyConfig, preference: DeliveryPreference = "auto"): DeliveryDecision {
  const effective = sizeBytes === null ? null : sizeBytes * (approx ? UNCERTAIN_MARGIN : 1);
  const reject = (rejected: NonNullable<DeliveryDecision["rejected"]>): DeliveryDecision => ({ mode: null, allowLinkFallback: false, rejected, badge: "rejected" });
  const link = (fallback = false): DeliveryDecision => ({ mode: "r2_link", allowLinkFallback: fallback, rejected: null, badge: "link" });
  const direct = (mode: DeliveryMode, fallback: boolean): DeliveryDecision => ({ mode, allowLinkFallback: fallback, rejected: null, badge: "direct" });
  const fits = (limit: number) => effective === null || effective <= limit;

  if (effective !== null && effective > cfg.maxOutputBytes) return reject("exceeds_max");

  // an operator-level policy other than "auto" overrides the user's preference
  const wanted: DeliveryPreference = cfg.deliveryPolicy !== "auto" ? cfg.deliveryPolicy : preference;

  switch (wanted) {
    case "r2_link":
      return cfg.linkDeliveryEnabled ? link() : reject("mode_unavailable");
    case "bot_api_cloud":
      return fits(cfg.cloudUploadLimitBytes) ? direct("bot_api_cloud", false) : reject("exceeds_mode");
    case "mtproto":
      if (!cfg.mtprotoEnabled) return reject("mode_unavailable");
      return fits(cfg.mtprotoUploadLimitBytes) ? direct("mtproto", false) : reject("exceeds_mode");
    case "bot_api_local":
      if (!cfg.localBotApiEnabled) return reject("mode_unavailable");
      return fits(cfg.localUploadLimitBytes) ? direct("bot_api_local", false) : reject("exceeds_mode");
    case "auto":
      break;
  }

  // automatic: the smallest mechanism that can carry the file
  if (effective === null) return direct("bot_api_cloud", true); // unknown size: try Telegram, upgrade/fall back after the download
  if (effective <= cfg.cloudUploadLimitBytes) return direct("bot_api_cloud", true);
  if (cfg.mtprotoEnabled && effective <= cfg.mtprotoUploadLimitBytes) return direct("mtproto", true);
  if (cfg.localBotApiEnabled && effective <= cfg.localUploadLimitBytes) return direct("bot_api_local", true);
  if (cfg.linkDeliveryEnabled) return link();
  return reject("exceeds_mode"); // too big for every enabled mechanism
}

export function explainRejection(d: DeliveryDecision): string {
  switch (d.rejected) {
    case "exceeds_max":
      return "exceeds the maximum allowed size";
    case "exceeds_mode":
      return "exceeds what the enabled delivery modes can send";
    case "mode_unavailable":
      return "this delivery mode is not enabled";
    default:
      return "";
  }
}
