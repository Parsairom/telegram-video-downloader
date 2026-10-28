#!/usr/bin/env node
// Registers (or with --delete removes) the Telegram webhook and the bot's command list, then prints the status.
// Reads BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and PUBLIC_BASE_URL from .env. TELEGRAM_PROXY (e.g. socks5h://127.0.0.1:1080)
// is used for the call if Telegram is blocked on this machine; the bot token never appears in argv or output.
import { fail, readEnvFile, requireEnv, step, telegramCall } from "./lib.mjs";

const env = readEnvFile();
const proxy = env.TELEGRAM_PROXY || undefined;
const remove = process.argv.includes("--delete");
requireEnv(env, ["BOT_TOKEN"]);

step("Checking the bot token");
const me = telegramCall(env.BOT_TOKEN, "getMe", {}, { proxy, get: true });
if (!me.ok) fail(`Telegram rejected the token: ${me.description}`);
console.log(`  bot: @${me.result.username} (${me.result.first_name})`);

if (remove) {
  step("Removing the webhook");
  const r = telegramCall(env.BOT_TOKEN, "deleteWebhook", { drop_pending_updates: false }, { proxy });
  console.log(`  deleteWebhook -> ${r.ok ? "ok" : r.description}`);
  process.exit(r.ok ? 0 : 1);
}

requireEnv(env, ["TELEGRAM_WEBHOOK_SECRET", "PUBLIC_BASE_URL"]);
if (!/^https:\/\//.test(env.PUBLIC_BASE_URL)) fail("PUBLIC_BASE_URL must be an https:// URL (Telegram only delivers webhooks over HTTPS)");
const url = `${env.PUBLIC_BASE_URL.replace(/\/+$/, "")}/telegram/webhook`;

step(`Setting the webhook -> ${url}`);
const set = telegramCall(env.BOT_TOKEN, "setWebhook", {
  url,
  secret_token: env.TELEGRAM_WEBHOOK_SECRET,
  allowed_updates: ["message", "callback_query"],
  max_connections: 40,
  drop_pending_updates: false,
}, { proxy });
if (!set.ok) fail(`setWebhook failed: ${set.description}`);
console.log("  setWebhook -> ok");

step("Setting the command menus (Persian default, English)");
const fa = [
  { command: "start", description: "شروع و منوی اصلی" },
  { command: "help", description: "راهنما" },
  { command: "settings", description: "تنظیمات" },
  { command: "history", description: "تاریخچه دانلودها" },
  { command: "cancel", description: "لغو دانلودهای فعال" },
  { command: "privacy", description: "حریم خصوصی" },
];
const en = [
  { command: "start", description: "Start and main menu" },
  { command: "help", description: "Help" },
  { command: "settings", description: "Settings" },
  { command: "history", description: "Download history" },
  { command: "cancel", description: "Cancel active downloads" },
  { command: "privacy", description: "Privacy" },
];
console.log(`  default (fa): ${telegramCall(env.BOT_TOKEN, "setMyCommands", { commands: fa }, { proxy }).ok ? "ok" : "failed"}`);
console.log(`  en:           ${telegramCall(env.BOT_TOKEN, "setMyCommands", { commands: en, language_code: "en" }, { proxy }).ok ? "ok" : "failed"}`);

step("Webhook status");
const info = telegramCall(env.BOT_TOKEN, "getWebhookInfo", {}, { proxy, get: true });
const w = info.result ?? {};
console.log(`  url: ${w.url}\n  pending updates: ${w.pending_update_count}\n  last error: ${w.last_error_message ?? "none"}`);
if (w.url !== url) fail("the registered URL does not match");
