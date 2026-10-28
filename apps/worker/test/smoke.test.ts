import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("platform smoke test", () => {
  it("has the D1 schema applied", async () => {
    const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all<{ name: string }>();
    const names = results.map((r) => r.name);
    for (const table of ["users", "jobs", "job_events", "processed_updates", "rate_limits", "app_config", "daily_stats", "r2_objects"]) {
      expect(names).toContain(table);
    }
  });

  it("serves /health without leaking anything", async () => {
    const res = await exports.default.fetch(new Request("https://tvd.example.test/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("rejects webhook calls without the secret header", async () => {
    const res = await exports.default.fetch(new Request("https://tvd.example.test/telegram/webhook", { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
  });
});
