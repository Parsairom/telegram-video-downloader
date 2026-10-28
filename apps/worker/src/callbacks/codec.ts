/**
 * callback_data codec. Telegram allows 1–64 BYTES per button, so payloads are compact:
 *   <action>:<jobShortId>[:<arg>]      job actions
 *   s:<setting>:<value>                settings
 *   h:<page> / hd:<jobShortId> / hc / hcy   history
 *   ad:<sub>[:<arg>]                    admin
 *
 * A payload is only a *request*. Identity and ownership are always re-checked server-side
 * (the callback sender must own the job); nothing in the payload is trusted.
 */

export const CALLBACK_MAX_BYTES = 64;

export type JobAction =
  | "q" // pick a quality option (arg = option key)
  | "qa" // advanced formats list (arg = page)
  | "qt" // audio tracks list
  | "cu" // open the customise screen
  | "th" // thumbnail menu
  | "ths" // set thumbnail mode (arg = original|frame|none|custom)
  | "thp" // preview frames
  | "thf" // choose a preview frame (arg = index)
  | "thu" // upload own thumbnail
  | "ed" // edit a text field (arg = title|file|cap|etitle|eart)
  | "ed0" // clear embedded metadata
  | "ct" // container menu
  | "cts" // set container (arg)
  | "tc" // toggle "allow transcode"
  | "dm" // delivery menu
  | "dms" // set delivery (arg = auto|cloud|local|link)
  | "sa" // toggle send-as document
  | "go" // start the download
  | "bk" // back to the quality menu
  | "cx" // cancel
  | "rt" // retry a failed job
  | "pl" // choose a playlist entry (arg = index)
  | "cl" // close/delete the menu
  | "hd"; // history detail

const JOB_ACTIONS = new Set<string>(["q", "qa", "qt", "cu", "th", "ths", "thp", "thf", "thu", "ed", "ed0", "ct", "cts", "tc", "dm", "dms", "sa", "go", "bk", "cx", "rt", "pl", "cl", "hd"]);

export type Parsed =
  | { kind: "job"; action: JobAction; shortId: string; arg: string | null }
  | { kind: "setting"; key: string; value: string }
  | { kind: "history"; sub: "page" | "clear" | "clear_yes"; arg: string | null }
  | { kind: "admin"; sub: string; arg: string | null }
  | { kind: "noop" };

const SHORT_ID = /^[A-Za-z0-9]{6,16}$/;
const ARG = /^[A-Za-z0-9_.-]{0,32}$/;

export function encodeJob(action: JobAction, shortId: string, arg?: string | number): string {
  const data = arg === undefined ? `${action}:${shortId}` : `${action}:${shortId}:${arg}`;
  assertSize(data);
  return data;
}

export function encodeSetting(key: string, value: string): string {
  const data = `s:${key}:${value}`;
  assertSize(data);
  return data;
}

export function encodeHistory(sub: "page" | "clear" | "clear_yes", arg?: number): string {
  const data = sub === "page" ? `h:${arg ?? 0}` : sub === "clear" ? "hc" : "hcy";
  assertSize(data);
  return data;
}

export function encodeAdmin(sub: string, arg?: string): string {
  const data = arg === undefined ? `ad:${sub}` : `ad:${sub}:${arg}`;
  assertSize(data);
  return data;
}

function assertSize(data: string): void {
  if (new TextEncoder().encode(data).length > CALLBACK_MAX_BYTES) throw new Error(`callback_data too long (${data})`);
}

/** Parse callback_data; anything malformed becomes `noop` (it is attacker-controlled input). */
export function parseCallback(data: string | undefined): Parsed {
  if (!data || data.length > CALLBACK_MAX_BYTES) return { kind: "noop" };
  const parts = data.split(":");
  const head = parts[0] ?? "";
  if (head === "s" && parts.length === 3 && ARG.test(parts[1]!) && ARG.test(parts[2]!)) return { kind: "setting", key: parts[1]!, value: parts[2]! };
  if (head === "h" && parts.length === 2 && /^\d{1,4}$/.test(parts[1]!)) return { kind: "history", sub: "page", arg: parts[1]! };
  if (head === "hc" && parts.length === 1) return { kind: "history", sub: "clear", arg: null };
  if (head === "hcy" && parts.length === 1) return { kind: "history", sub: "clear_yes", arg: null };
  if (head === "ad" && parts.length >= 2 && ARG.test(parts[1]!) && (parts[2] === undefined || ARG.test(parts[2]))) return { kind: "admin", sub: parts[1]!, arg: parts[2] ?? null };
  if (JOB_ACTIONS.has(head) && parts.length >= 2 && SHORT_ID.test(parts[1]!) && (parts[2] === undefined || ARG.test(parts[2]))) {
    return { kind: "job", action: head as JobAction, shortId: parts[1]!, arg: parts[2] ?? null };
  }
  return { kind: "noop" };
}
