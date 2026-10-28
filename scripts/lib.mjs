// Shared helpers for the operational scripts. No dependencies; never prints secret values.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const WORKER_DIR = join(ROOT, "apps", "worker");
export const ENV_FILE = join(ROOT, ".env");

/**
 * Deployment profile. `free` (default) = Worker on the Workers Free plan + media engine on your own computer
 * (wrangler.free.jsonc); `--paid` = Containers/R2/Durable Objects profile (wrangler.jsonc, Workers Paid plan).
 */
export const PROFILE = process.argv.includes("--paid") ? "paid" : "free";
/** Tracked template (placeholder resource ids). */
export const WRANGLER_TEMPLATE = join(WORKER_DIR, PROFILE === "paid" ? "wrangler.jsonc" : "wrangler.free.jsonc");
/** Git-ignored copy of the template that `npm run provision` fills in with your resource ids and every wrangler call below uses. */
export const WRANGLER_CONFIG = join(WORKER_DIR, PROFILE === "paid" ? "wrangler.local.jsonc" : "wrangler.free.local.jsonc");
export const PLACEHOLDER_DB_ID = "REPLACE_WITH_D1_DATABASE_ID";

export const SECRET_KEYS = ["BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "INTERNAL_SIGNING_SECRET", "CONTAINER_API_KEY", "TELEGRAM_API_HASH", "LOCAL_BOT_TOKEN"];

/**
 * Secrets uploaded to Cloudflare. In the free profile the Telegram API id/hash and the local Bot API token stay on
 * your computer (only the media engine uses them), so they are never sent to Cloudflare.
 */
export const WORKER_SECRET_KEYS =
  PROFILE === "paid"
    ? ["BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "INTERNAL_SIGNING_SECRET", "CONTAINER_API_KEY", "ADMIN_USER_IDS", "TELEGRAM_API_ID", "TELEGRAM_API_HASH", "LOCAL_BOT_TOKEN"]
    : ["BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "INTERNAL_SIGNING_SECRET", "CONTAINER_API_KEY", "ADMIN_USER_IDS"];

/** Parse KEY=VALUE lines (no interpolation, '#' comments, optional quotes). */
export function readEnvFile(file = ENV_FILE) {
  const env = {};
  if (!existsSync(file)) return env;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    env[m[1]] = value;
  }
  return env;
}

/** Update or append keys in the .env file, preserving comments and other lines. */
export function writeEnvKeys(updates, file = ENV_FILE) {
  const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : [];
  const remaining = new Map(Object.entries(updates));
  const out = lines.map((line) => {
    const m = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (m && remaining.has(m[1])) {
      const v = remaining.get(m[1]);
      remaining.delete(m[1]);
      return `${m[1]}=${v}`;
    }
    return line;
  });
  for (const [k, v] of remaining) out.push(`${k}=${v}`);
  writeFileSync(file, out.join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
}

export function randomSecret(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function mask(value) {
  if (!value) return "(unset)";
  return value.length <= 8 ? "****" : `${value.slice(0, 3)}…${value.slice(-2)} (${value.length} chars)`;
}

/** Remove anything that looks like a bot token / bearer token from text before printing it. */
export function redact(text) {
  return String(text)
    .replace(/(?<!\d)\d{6,}:[A-Za-z0-9_-]{30,}/g, "[redacted-bot-token]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(CLOUDFLARE_API_TOKEN|api[_-]?token)\s*[=:]\s*\S+/gi, "$1=[redacted]");
}

/** Run `npx wrangler …` inside apps/worker. Returns { code, stdout, stderr }. Output is redacted when printed. */
export function wrangler(args, { input, env = {}, quiet = false, cwd = WORKER_DIR } = {}) {
  const fileEnv = readEnvFile();
  if (!existsSync(WRANGLER_CONFIG)) copyFileSync(WRANGLER_TEMPLATE, WRANGLER_CONFIG);
  // `npx` runs through cmd.exe on Windows, which splits unquoted arguments at spaces (this repo may live under "C:\Users\First Last\…")
  const quote = (a) => (process.platform === "win32" && /\s/.test(a) ? `"${a}"` : a);
  const result = spawnSync("npx", ["wrangler", ...args, "--config", relative(cwd, WRANGLER_CONFIG)].map(quote), {
    cwd,
    input,
    encoding: "utf8",
    shell: process.platform === "win32", // npx is a .cmd on Windows
    env: { ...process.env, CI: "1", ...(fileEnv.CLOUDFLARE_ACCOUNT_ID ? { CLOUDFLARE_ACCOUNT_ID: fileEnv.CLOUDFLARE_ACCOUNT_ID } : {}), ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (!quiet) {
    if (stdout.trim()) console.log(redact(stdout.trimEnd()));
    if (stderr.trim() && result.status !== 0) console.error(redact(stderr.trimEnd()));
  }
  return { code: result.status ?? 1, stdout, stderr };
}

export function step(title) {
  console.log(`\n▶ ${title}`);
}

export function fail(message, code = 1) {
  console.error(`\n✖ ${message}`);
  process.exit(code);
}

export function requireEnv(env, keys) {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) fail(`Missing in .env: ${missing.join(", ")} (see .env.example)`);
}

/** curl is used for Telegram so a SOCKS/HTTP proxy can be applied (Telegram is blocked in some countries). The URL (which contains the bot token) is passed on stdin, not argv. */
export function telegramCall(token, method, params = {}, { proxy, get = false } = {}) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const config = [`url = "${url}"`, "silent", "show-error", "max-time = 40"];
  if (proxy) config.push(`proxy = "${proxy}"`);
  if (!get) config.push("request = POST", "header = \"content-type: application/json\"", `data = "${JSON.stringify(params).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  const res = spawnSync("curl", ["--config", "-"], { input: config.join("\n"), encoding: "utf8" });
  if (res.error) throw new Error(`curl failed: ${res.error.message}`);
  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new Error(`Telegram did not answer (is it blocked? set TELEGRAM_PROXY in .env): ${redact(res.stderr || res.stdout).slice(0, 200)}`);
  }
}
