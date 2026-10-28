#!/usr/bin/env node
// Generates the secrets that must be random (and writes them to .env), then uploads all secrets to the Worker.
//   node scripts/set-secrets.mjs                 generate missing + upload
//   node scripts/set-secrets.mjs --generate-only only fill .env
// Secret values are never printed.
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKER_SECRET_KEYS, fail, mask, randomSecret, readEnvFile, requireEnv, step, wrangler, writeEnvKeys } from "./lib.mjs";

const generateOnly = process.argv.includes("--generate-only");
let env = readEnvFile();

step("Generating missing random secrets");
const generated = {};
for (const key of ["TELEGRAM_WEBHOOK_SECRET", "INTERNAL_SIGNING_SECRET", "CONTAINER_API_KEY"]) {
  if (!env[key]) generated[key] = randomSecret(32);
}
if (Object.keys(generated).length) {
  writeEnvKeys(generated);
  console.log(`  generated: ${Object.keys(generated).join(", ")} (stored in .env, mode 600)`);
} else {
  console.log("  nothing to generate");
}
env = readEnvFile();
requireEnv(env, ["BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "INTERNAL_SIGNING_SECRET", "CONTAINER_API_KEY"]);
if (!/^[A-Za-z0-9_-]{16,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET)) fail("TELEGRAM_WEBHOOK_SECRET must be 16-256 chars of A-Z a-z 0-9 _ -");
if (!/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(env.BOT_TOKEN)) fail("BOT_TOKEN does not look like a Telegram bot token");

if (generateOnly) process.exit(0);

step("Uploading secrets to Cloudflare");
const payload = {};
for (const key of WORKER_SECRET_KEYS) {
  if (env[key]) payload[key] = env[key];
}
for (const [k, v] of Object.entries(payload)) console.log(`  ${k.padEnd(26)} ${k === "ADMIN_USER_IDS" || k === "TELEGRAM_API_ID" ? v : mask(v)}`);
if (!payload.ADMIN_USER_IDS) console.log("  ! ADMIN_USER_IDS is empty: admin commands are disabled until you set it (see scripts/discover-admin.mjs)");

const file = join(tmpdir(), `tvd-secrets-${process.pid}.json`);
writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });
try {
  const res = wrangler(["secret", "bulk", file], { quiet: true });
  if (res.code !== 0) {
    console.error(`${res.stdout}\n${res.stderr}`.split("\n").filter((l) => l.trim()).slice(-8).join("\n"));
    fail("wrangler secret bulk failed (has the Worker been deployed once? run `npm run deploy` first, or use `wrangler deploy` then retry)");
  }
} finally {
  try {
    unlinkSync(file);
  } catch {
    /* already gone */
  }
}
console.log("\n✔ Secrets uploaded.");
