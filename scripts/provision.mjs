#!/usr/bin/env node
// Creates the Cloudflare resources the Worker needs and applies the D1 migrations. Idempotent.
//   node scripts/provision.mjs            create everything for the free profile (D1 + queues; no R2)
//   node scripts/provision.mjs --paid     paid profile: also the R2 bucket and its lifecycle rules
//   node scripts/provision.mjs --dry-run  show what would be done
import { readFileSync, writeFileSync } from "node:fs";
import { PROFILE, WRANGLER_CONFIG, fail, readEnvFile, step, wrangler } from "./lib.mjs";

const dry = process.argv.includes("--dry-run");
const env = readEnvFile();
const D1_NAME = env.D1_DATABASE_NAME || "tvd-db";
const BUCKET = env.R2_BUCKET || "tvd-media";
const QUEUE = env.QUEUE_NAME || "tvd-jobs";

function run(label, args, okIfExists = /already exists|already taken|10004|10006/i) {
  console.log(`  · wrangler ${args.join(" ")}`);
  if (dry) return { code: 0, stdout: "", stderr: "" };
  const res = wrangler(args, { quiet: true });
  const text = `${res.stdout}\n${res.stderr}`;
  if (res.code !== 0 && !okIfExists.test(text)) {
    console.error(text.split("\n").filter((l) => l.trim()).slice(-8).join("\n"));
    fail(`${label} failed`);
  }
  if (res.code !== 0) console.log("    (already exists — fine)");
  return res;
}

step("Checking Cloudflare access");
if (!dry) {
  const who = wrangler(["whoami"], { quiet: true });
  if (who.code !== 0 && !/Account ID/i.test(who.stdout)) console.log("  whoami is not conclusive; continuing (commands below will fail loudly if not logged in)");
}

step(`D1 database "${D1_NAME}"`);
const created = run("D1 create", ["d1", "create", D1_NAME]);
let databaseId = /database_id"?\s*[:=]\s*"?([0-9a-f-]{36})/i.exec(`${created.stdout}${created.stderr}`)?.[1];
if (!databaseId && !dry) {
  const info = wrangler(["d1", "info", D1_NAME, "--json"], { quiet: true });
  try {
    databaseId = JSON.parse(info.stdout).uuid;
  } catch {
    /* fall through */
  }
}
if (!databaseId && !dry) fail("could not determine the D1 database id");

if (databaseId) {
  const cfg = readFileSync(WRANGLER_CONFIG, "utf8");
  const next = cfg.replace(/("database_id"\s*:\s*")[^"]*(")/, `$1${databaseId}$2`).replace(/("database_name"\s*:\s*")[^"]*(")/, `$1${D1_NAME}$2`);
  if (next !== cfg && !dry) writeFileSync(WRANGLER_CONFIG, next);
  console.log(`  database id written to ${WRANGLER_CONFIG.split(/[\\/]/).pop()} (${databaseId.slice(0, 8)}…)`);
}

step("Applying D1 migrations (remote)");
run("D1 migrations", ["d1", "migrations", "apply", D1_NAME, "--remote"], /No migrations to apply/i);

if (PROFILE === "paid") {
  step(`R2 bucket "${BUCKET}"`);
  run("R2 create", ["r2", "bucket", "create", BUCKET]);
  // delivery links live at most FILE_RETENTION_HOURS (24h default); the lifecycle rule is the safety net if cleanup ever stops
  run("R2 lifecycle (expire deliveries after 2 days)", ["r2", "bucket", "lifecycle", "add", BUCKET, "expire-deliveries", "deliveries/", "--expire-days", "2"], /already exists|exists/i);
  run("R2 lifecycle (abort stale multipart uploads)", ["r2", "bucket", "lifecycle", "add", BUCKET, "abort-multipart", "", "--abort-multipart-days", "1"], /already exists|exists/i);
} else {
  console.log("\n▶ R2 bucket: skipped (free profile delivers through Telegram only; no R2 needed)");
}

step(`Queues "${QUEUE}" and "${QUEUE}-dlq"`);
run("queue create", ["queues", "create", QUEUE]);
run("dead-letter queue create", ["queues", "create", `${QUEUE}-dlq`]);

console.log(`\n✔ Provisioning ${dry ? "plan" : "done"}. Next: npm run secrets && npm run deploy`);
