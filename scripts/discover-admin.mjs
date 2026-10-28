#!/usr/bin/env node
// Finds your numeric Telegram user id so you can put it in ADMIN_USER_IDS.
//   1. Send any message to your bot (e.g. /start).
//   2. Run:  node scripts/discover-admin.mjs            (must run BEFORE the webhook is set — getUpdates is unavailable while a webhook exists)
//      or:   node scripts/discover-admin.mjs --write    to store the id in .env
import { fail, readEnvFile, requireEnv, telegramCall, writeEnvKeys } from "./lib.mjs";

const env = readEnvFile();
requireEnv(env, ["BOT_TOKEN"]);
const res = telegramCall(env.BOT_TOKEN, "getUpdates", { limit: 50, timeout: 0, allowed_updates: ["message"] }, { proxy: env.TELEGRAM_PROXY || undefined });
if (!res.ok) fail(`getUpdates failed: ${res.description} (if a webhook is set, run: node scripts/set-webhook.mjs --delete)`);

const people = new Map();
for (const u of res.result) {
  const from = u.message?.from;
  if (from && !from.is_bot) people.set(from.id, `${from.first_name ?? ""} ${from.username ? `@${from.username}` : ""}`.trim());
}
if (people.size === 0) fail("No messages found. Send /start to your bot first, then run this again.");
for (const [id, label] of people) console.log(`${id}  ${label}`);
if (process.argv.includes("--write")) {
  if (people.size !== 1) fail("More than one sender found; set ADMIN_USER_IDS in .env manually.");
  writeEnvKeys({ ADMIN_USER_IDS: String([...people.keys()][0]) });
  console.log("✔ ADMIN_USER_IDS written to .env");
}
