#!/usr/bin/env node
// Deploys the Worker, uploading secrets in the same step, then registers the Telegram webhook.
// Profiles: default = free (apps/worker/wrangler.free.jsonc: Worker only, the media engine runs on your computer);
//           --paid = apps/worker/wrangler.jsonc (Containers + R2 + Durable Objects, needs Workers Paid).
//   node scripts/deploy.mjs                    deploy (free profile)
//   node scripts/deploy.mjs --paid             deploy the paid profile incl. the container image
//   node scripts/deploy.mjs --paid --worker-only   paid profile, Worker code only; running containers are left untouched (--containers-rollout none)
//   node scripts/deploy.mjs --skip-tests       skip typecheck/lint/tests
//   node scripts/deploy.mjs --no-webhook       do not touch the Telegram webhook
// Rollback: see docs/operations.md ("Rolling back").
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLACEHOLDER_DB_ID, PROFILE, ROOT, WORKER_SECRET_KEYS, WRANGLER_CONFIG, fail, readEnvFile, redact, requireEnv, step, wrangler, writeEnvKeys } from "./lib.mjs";

const args = new Set(process.argv.slice(2));
const env = readEnvFile();
requireEnv(env, ["BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "INTERNAL_SIGNING_SECRET", "CONTAINER_API_KEY"]);
if (!existsSync(WRANGLER_CONFIG) || readFileSync(WRANGLER_CONFIG, "utf8").includes(PLACEHOLDER_DB_ID)) {
  fail("no D1 database id yet — run `npm run provision` first (it creates the resources and records their ids in the git-ignored local wrangler config)");
}

if (!args.has("--skip-tests")) {
  step("Typecheck, lint and tests");
  for (const cmd of [["run", "typecheck"], ["run", "lint"], ["test"]]) {
    const r = spawnSync("npm", cmd, { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
    if (r.status !== 0) fail(`npm ${cmd.join(" ")} failed — not deploying`);
  }
}

const secretsFile = join(tmpdir(), `tvd-deploy-secrets-${process.pid}.json`);
const secrets = {};
for (const key of WORKER_SECRET_KEYS) {
  if (env[key]) secrets[key] = env[key];
}
writeFileSync(secretsFile, JSON.stringify(secrets), { mode: 0o600 });

function deploy(extra = []) {
  const base = ["deploy", "--secrets-file", secretsFile, ...extra];
  // the free profile has no containers; in the paid profile --worker-only leaves running containers untouched
  if (PROFILE === "paid" && args.has("--worker-only")) base.push("--containers-rollout", "none");
  return wrangler(base, { quiet: true });
}

try {
  step("Deploying to Cloudflare (first pass)");
  let publicUrl = env.PUBLIC_BASE_URL?.replace(/\/+$/, "");
  let res = deploy(publicUrl ? ["--var", `PUBLIC_BASE_URL:${publicUrl}`] : []);
  const output = redact(`${res.stdout}\n${res.stderr}`);
  if (res.code !== 0) {
    console.error(output.split("\n").filter((l) => l.trim()).slice(-25).join("\n"));
    fail("wrangler deploy failed");
  }
  console.log(output.split("\n").filter((l) => /Deployed|https?:\/\/|Uploaded|Current Version|container|Queue|Trigger/i.test(l)).join("\n"));

  const found = /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i.exec(output)?.[0];
  if (!publicUrl && found) {
    publicUrl = found;
    writeEnvKeys({ PUBLIC_BASE_URL: publicUrl });
    step(`Second pass: setting PUBLIC_BASE_URL=${publicUrl} (container callbacks and download links need it)`);
    res = deploy(["--var", `PUBLIC_BASE_URL:${publicUrl}`, ...(PROFILE === "paid" && !args.has("--worker-only") ? ["--containers-rollout", "none"] : [])]);
    if (res.code !== 0) {
      console.error(redact(`${res.stdout}\n${res.stderr}`).split("\n").slice(-15).join("\n"));
      fail("second deploy failed");
    }
  }
  if (!publicUrl) fail("could not determine the Worker URL; set PUBLIC_BASE_URL in .env and run again");

  if (!args.has("--no-webhook")) {
    step("Registering the Telegram webhook");
    const r = spawnSync(process.execPath, [join(ROOT, "scripts", "set-webhook.mjs")], { cwd: ROOT, stdio: "inherit" });
    if (r.status !== 0) fail("webhook registration failed (see above)");
  }
  console.log(`\n✔ Deployed: ${publicUrl}`);
} finally {
  try {
    unlinkSync(secretsFile);
  } catch {
    /* already removed */
  }
}
