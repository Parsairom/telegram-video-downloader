/** Text helpers shared by the Persian/English catalogs: HTML escaping, numbers, sizes, durations. */

const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

export const toFa = (value: string | number): string => String(value).replace(/\d/g, (d) => FA_DIGITS[Number(d)]!);

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function clip(text: string, limit: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= limit ? t : `${t.slice(0, Math.max(limit - 1, 0)).trimEnd()}…`;
}

/** Right-to-left mark: keeps a line that starts with Latin text (a title, a URL) laid out RTL inside a Persian chat. */
export const RLM = "\u200f";

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return `${i === 0 ? Math.round(n) : n.toFixed(n >= 100 ? 0 : 1)} ${units[i]}`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return "—";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export function formatSpeed(bytesPerSecond: number | null | undefined): string | null {
  return bytesPerSecond && bytesPerSecond > 0 ? `${formatBytes(bytesPerSecond)}/s` : null;
}

export function progressBar(percent: number, width = 12): string {
  const p = Math.min(Math.max(percent, 0), 100);
  const filled = Math.round((p / 100) * width);
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}

export function formatDate(epochSeconds: number | null | undefined): string {
  if (!epochSeconds) return "—";
  return new Date(epochSeconds * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function formatUploadDate(yyyymmdd: string | null | undefined): string | null {
  return yyyymmdd && /^\d{8}$/.test(yyyymmdd) ? `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6)}` : null;
}

/** Sanitise a user-typed file name: no separators, control or bidi characters; the container adds the extension. */
export function sanitizeFilename(input: string, max = 120): string {
  const cleaned = input
    .normalize("NFKC")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[-.\s]+|[.\s]+$/g, "");
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned) ? `_${cleaned}` : cleaned;
  return reserved.slice(0, max).trimEnd();
}
