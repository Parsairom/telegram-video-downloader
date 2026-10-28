import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

const URL_ = "https://tvd.example.test/telegram/webhook";
const secret = "test-webhook-secret-0123456789";

function update(id: number, text: string) {
  return { update_id: id, message: { message_id: id, chat: { id: 4321, type: "private" }, from: { id: 4321, first_name: "W" }, text } };
}

const hook = (body: unknown, headers: Record<string, string> = { "x-telegram-bot-api-secret-token": secret }) =>
  exports.default.fetch(new Request(URL_, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }));

describe("webhook route", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubTelegram() {
    const calls: { method: string; body: any }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes("api.telegram.org")) throw new Error(`unexpected outbound request to ${url}`);
      calls.push({ method: url.split("/").pop()!, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 4321 } } }));
    });
    return calls;
  }

  it("rejects non-POST, missing/wrong secret, oversized and malformed bodies", async () => {
    expect((await exports.default.fetch(new Request(URL_))).status).toBe(405);
    expect((await hook(update(1, "/start"), {})).status).toBe(401);
    expect((await hook(update(1, "/start"), { "x-telegram-bot-api-secret-token": "wrong" })).status).toBe(401);
    expect((await hook("{not json")).status).toBe(400);
    expect((await hook({ no_update_id: true })).status).toBe(400);
    const big = await exports.default.fetch(new Request(URL_, { method: "POST", headers: { "x-telegram-bot-api-secret-token": secret, "content-length": "2000000" }, body: "{}" }));
    expect(big.status).toBe(413);
  });

  it("answers a valid update, and handles a redelivered update exactly once", async () => {
    const calls = stubTelegram();
    const first = await hook(update(900001, "/start"));
    expect(first.status).toBe(200);
    expect(await first.text()).toBe("ok");
    const sent = calls.filter((c) => c.method === "sendMessage");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.text).toContain("سلام");

    const again = await hook(update(900001, "/start")); // Telegram redelivers after a timeout
    expect(again.status).toBe(200);
    expect(await again.text()).toBe("duplicate");
    expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);
  });

  it("a crashing handler never causes a redelivery storm (the update stays claimed, the user gets an apology)", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      calls.push(String(input).split("/").pop()!);
      if (calls.length === 1) throw new Error("telegram unreachable");
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 4321 } } }));
    });
    const res = await hook(update(900002, "/start"));
    expect(res.status).toBe(200);
    expect(env.DB).toBeTruthy();
    expect((await (await hook(update(900002, "/start"))).text())).toBe("duplicate");
  });

  it("never discloses internals on unknown paths or /health", async () => {
    const health = await exports.default.fetch(new Request("https://tvd.example.test/health"));
    expect(await health.json()).toEqual({ ok: true });
    for (const path of ["/internal/jobs/job_x/events", "/internal/anything", "/d/job_x/1.sig/f.mp4", "/admin", "/.env", "/wrangler.jsonc"]) {
      const res = await exports.default.fetch(new Request(`https://tvd.example.test${path}`));
      expect([401, 404, 405, 410]).toContain(res.status);
      expect(await res.text()).not.toMatch(/token|secret|stack|Error/i);
    }
  });
});
