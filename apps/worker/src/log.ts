/** Structured JSON logging with secret redaction. Every job log line carries its correlation id. */

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY = /token|secret|authorization|cookie|password|signature|api[-_]?key|api[-_]?hash|credential/i;
// no \b here: in API URLs the token directly follows the word "bot" (…/bot123456:AAH…/getMe)
const BOT_TOKEN = /(?<!\d)\d{6,}:[A-Za-z0-9_-]{30,}/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const URL_SECRET_PARAM = /([?&](?:token|sig|signature|key|secret|X-Amz-Signature|X-Amz-Credential)=)[^&\s"']+/gi;

export function redactString(value: string): string {
  return value.replace(BOT_TOKEN, "[redacted-bot-token]").replace(BEARER, "Bearer [redacted]").replace(URL_SECRET_PARAM, "$1[redacted]");
}

export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object" || depth > 6) return value;
  if (value instanceof Error) return { name: value.name, message: redactString(value.message), stack: value.stack ? redactString(value.stack) : undefined };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export function createLogger(level: Level = "info", base: Record<string, unknown> = {}, sink: (line: string) => void = console.log): Logger {
  const emit = (lvl: Level, msg: string, extra?: Record<string, unknown>) => {
    if (ORDER[lvl] < ORDER[level]) return;
    sink(JSON.stringify(redact({ ts: new Date().toISOString(), level: lvl, msg, ...base, ...extra })));
  };
  return {
    debug: (m, e) => emit("debug", m, e),
    info: (m, e) => emit("info", m, e),
    warn: (m, e) => emit("warn", m, e),
    error: (m, e) => emit("error", m, e),
    child: (fields) => createLogger(level, { ...base, ...fields }, sink),
  };
}
