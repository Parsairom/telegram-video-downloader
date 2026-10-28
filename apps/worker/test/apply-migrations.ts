import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}

// Runs before every test file: gives each file an up-to-date schema.
await applyD1Migrations(env.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);

const TABLES = ["job_events", "jobs", "users", "processed_updates", "rate_limits", "app_config", "daily_stats", "r2_objects"];

// ...and a clean database before every test (the tests use a frozen clock, so leftovers would trip duplicate
// detection and rate limits).
beforeEach(async () => {
  for (const table of TABLES) await env.DB.prepare(`DELETE FROM ${table}`).run();
  const listed = await env.MEDIA_BUCKET.list({ limit: 1000 });
  if (listed.objects.length) await env.MEDIA_BUCKET.delete(listed.objects.map((o) => o.key));
});
