import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // test-only values; real secrets live in Cloudflare (wrangler secret put)
            BOT_TOKEN: "123456:TEST-TOKEN-NOT-REAL-aaaaaaaaaaaaaaaaaaaa",
            TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret-0123456789",
            INTERNAL_SIGNING_SECRET: "test-internal-signing-secret-0123456789",
            CONTAINER_API_KEY: "test-container-key",
            ADMIN_USER_IDS: "9001",
            PUBLIC_BASE_URL: "https://tvd.example.test",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      include: ["test/**/*.test.ts"],
    },
  };
});
