import type { InspectResult } from "@tvd/shared-types";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { messages } from "../src/bot/i18n";
import { Telegram, TelegramError } from "../src/bot/telegram";
import { ConfigError, parseConfig } from "../src/config";
import type { JobRow } from "../src/db/types";
import { handleDownload, handleInternal } from "../src/internal/routes";
import { deliveryKeyboard } from "../src/keyboards";
import { signJobToken } from "../src/security/hmac";
import { BackendUnavailable } from "../src/services/container";
import { ENGINE_FRESH_SECONDS, HttpBackend, isAcceptableEngineUrl, loadEngine, saveEngine } from "../src/services/engine";
import { decideDelivery } from "../src/services/size-policy";
import { ALICE, containerEvent, directResult, latestJob, reload, startDownload } from "./flow-helpers";
import { buttonData, callback, makeHarness, sampleInfo, send, testConfig, userMessage, allButtons } from "./helpers";

// Free-plan hybrid profile: Worker on Workers Free, media engine on the admin's computer (HTTP backend), MTProto delivery, no R2.
const FREE = { MEDIA_BACKEND: "http", MTPROTO_ENABLED: "true", MEDIA_BUCKET: undefined } as const;
const NOW = 1_760_000_000;
const ENGINE_URL = "https://random-words-here.trycloudflare.com";

describe("free-profile configuration", () => {
  it("reads the backend, MTProto and R2 availability from the environment", () => {
    const cfg = testConfig(FREE);
    expect(cfg).toMatchObject({ mediaBackend: "http", mtprotoEnabled: true, linkDeliveryEnabled: false, mtprotoUploadLimitBytes: 2_000_000_000 });
    const paid = testConfig();
    expect(paid).toMatchObject({ mediaBackend: "container", mtprotoEnabled: false, linkDeliveryEnabled: true });
  });

  it("refuses operator policies that cannot work with what is configured", () => {
    expect(() => testConfig({ TELEGRAM_DELIVERY_MODE: "mtproto" })).toThrow(ConfigError);
    expect(() => testConfig({ ...FREE, TELEGRAM_DELIVERY_MODE: "r2_link" })).toThrow(/R2 bucket/);
    expect(testConfig({ MTPROTO_ENABLED: "true", TELEGRAM_DELIVERY_MODE: "mtproto" }).deliveryPolicy).toBe("mtproto");
    expect(() => parseConfig({ ...(env as unknown as Record<string, unknown>), MEDIA_BACKEND: "carrier-pigeon" })).toThrow(ConfigError);
  });
});

describe("delivery policy with MTProto (bytes)", () => {
  const free = testConfig(FREE);
  const both = testConfig({ MTPROTO_ENABLED: "true" }); // paid profile with MTProto switched on
  const noMtproto = testConfig({ MEDIA_BUCKET: undefined }); // neither MTProto nor links

  it("auto: Bot API up to 50 MB, MTProto above it", () => {
    expect(decideDelivery(30_000_000, false, free)).toMatchObject({ mode: "bot_api_cloud", badge: "direct" });
    expect(decideDelivery(900_000_000, false, free)).toMatchObject({ mode: "mtproto", badge: "direct", allowLinkFallback: true });
    expect(decideDelivery(1_850_000_000, false, free).mode).toBe("mtproto");
  });

  it("estimates get the 10% margin: 46 MB approx no longer fits the 50 MB Bot API", () => {
    expect(decideDelivery(46_000_000, false, free).mode).toBe("bot_api_cloud");
    expect(decideDelivery(46_000_000, true, free).mode).toBe("mtproto");
  });

  it("an unknown size starts with the Bot API and may upgrade afterwards", () => {
    expect(decideDelivery(null, false, free)).toMatchObject({ mode: "bot_api_cloud", allowLinkFallback: true });
  });

  it("MTProto is preferred over an R2 link when both exist", () => {
    expect(decideDelivery(900_000_000, false, both).mode).toBe("mtproto");
  });

  it("without MTProto and without R2 a big file is refused, not silently degraded", () => {
    expect(decideDelivery(900_000_000, false, noMtproto)).toMatchObject({ mode: null, rejected: "exceeds_mode", badge: "rejected" });
    expect(decideDelivery(30_000_000, false, noMtproto).mode).toBe("bot_api_cloud");
  });

  it("explicit choices never change behind the user's back", () => {
    expect(decideDelivery(60_000_000, false, free, "mtproto").mode).toBe("mtproto");
    expect(decideDelivery(60_000_000, false, free, "bot_api_cloud")).toMatchObject({ mode: null, rejected: "exceeds_mode" });
    expect(decideDelivery(60_000_000, false, free, "r2_link")).toMatchObject({ mode: null, rejected: "mode_unavailable" });
    expect(decideDelivery(60_000_000, false, noMtproto, "mtproto")).toMatchObject({ mode: null, rejected: "mode_unavailable" });
  });

  it("nothing above the application ceiling is accepted, whatever the mode", () => {
    expect(decideDelivery(1_900_000_001, false, free)).toMatchObject({ mode: null, rejected: "exceeds_max" });
    expect(decideDelivery(1_900_000_001, false, free, "mtproto")).toMatchObject({ mode: null, rejected: "exceeds_max" });
  });
});

describe("engine URLs", () => {
  it("accepts only public https hosts", () => {
    expect(isAcceptableEngineUrl(ENGINE_URL)).toBe(true);
    expect(isAcceptableEngineUrl("https://engine.example.com/")).toBe(true);
    for (const bad of [
      "http://random-words-here.trycloudflare.com",
      "https://127.0.0.1",
      "https://10.0.0.5:8443",
      "https://localhost",
      "https://printer.local",
      "https://db.internal",
      "https://[::1]",
      "https://user:pass@evil.example.com",
      "ftp://x.example.com",
      "not a url",
    ]) {
      expect(isAcceptableEngineUrl(bad), bad).toBe(false);
    }
  });
});

describe("engine registry (D1)", () => {
  it("stores, replaces and removes the registration; rejected URLs change nothing", async () => {
    expect(await loadEngine(env.DB)).toBeNull();
    expect(await saveEngine(env.DB, { url: `${ENGINE_URL}/`, name: "pc", ytdlp: "2026.10.21", activeJobs: 1, capabilities: { mtproto: true, localBotApi: false } }, NOW)).toBe("registered");
    expect(await loadEngine(env.DB)).toMatchObject({ url: ENGINE_URL, name: "pc", ytdlp: "2026.10.21", activeJobs: 1, capabilities: { mtproto: true }, lastSeen: NOW });

    expect(await saveEngine(env.DB, { url: "http://evil.example.com" }, NOW + 5)).toBe("rejected");
    expect((await loadEngine(env.DB))?.url).toBe(ENGINE_URL); // the previous registration survives

    expect(await saveEngine(env.DB, { url: "https://second.trycloudflare.com" }, NOW + 10)).toBe("registered");
    expect(await loadEngine(env.DB)).toMatchObject({ url: "https://second.trycloudflare.com", lastSeen: NOW + 10 });

    expect(await saveEngine(env.DB, { url: null }, NOW + 20)).toBe("removed");
    expect(await loadEngine(env.DB)).toBeNull();
  });
});

describe("POST /internal/engine/register", () => {
  async function register(body: unknown, opts: { key?: string | null; method?: string } = {}) {
    const h = makeHarness(FREE);
    const key = opts.key === undefined ? env.CONTAINER_API_KEY : opts.key;
    const request = new Request("https://tvd.example.test/internal/engine/register", {
      method: opts.method ?? "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      ...((opts.method ?? "POST") === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
    const res = await handleInternal(request, h.deps, new URL(request.url));
    return { h, status: res!.status, body: (await res!.json()) as Record<string, unknown> };
  }

  it("requires the shared key (constant-time comparison)", async () => {
    expect((await register({ url: ENGINE_URL }, { key: null })).status).toBe(401);
    expect((await register({ url: ENGINE_URL }, { key: "wrong-key" })).status).toBe(401);
    expect((await register({ url: ENGINE_URL }, { key: `${env.CONTAINER_API_KEY}x` })).status).toBe(401);
    expect(await loadEngine(env.DB)).toBeNull();
  });

  it("the job-event signing secret is not accepted as an engine key", async () => {
    expect((await register({ url: ENGINE_URL }, { key: env.INTERNAL_SIGNING_SECRET })).status).toBe(401);
  });

  it("accepts a heartbeat and stores it", async () => {
    const r = await register({ url: ENGINE_URL, name: "pc", ytdlp: "2026.10.21", activeJobs: 0, maxConcurrentJobs: 2, capabilities: { mtproto: true, localBotApi: false } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, outcome: "registered" });
    expect(await loadEngine(env.DB)).toMatchObject({ url: ENGINE_URL, maxConcurrentJobs: 2 });
  });

  it("refuses non-public or non-https URLs with 422", async () => {
    expect((await register({ url: "http://abc.trycloudflare.com" })).status).toBe(422);
    expect((await register({ url: "https://192.168.1.10:8080" })).status).toBe(422);
    expect((await register({ url: "https://metadata.internal" })).status).toBe(422);
    expect(await loadEngine(env.DB)).toBeNull();
  });

  it("rejects malformed bodies and wrong methods", async () => {
    expect((await register("{not json")).status).toBe(400);
    expect((await register({ url: 42 })).status).toBe(400);
    expect((await register({ name: "no url field" })).status).toBe(400);
    expect((await register({}, { method: "GET" })).status).toBe(405);
  });

  it("de-registers on {url: null}", async () => {
    await register({ url: ENGINE_URL });
    const r = await register({ url: null });
    expect(r.body).toEqual({ ok: true, outcome: "removed" });
    expect(await loadEngine(env.DB)).toBeNull();
  });
});

describe("HttpBackend (talks to the registered engine)", () => {
  interface Seen {
    url: string;
    method: string;
    auth: string | null;
    body: unknown;
  }

  function backend(responder: (seen: Seen) => Response | Promise<Response>, now = () => NOW) {
    const seen: Seen[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const entry: Seen = {
        url: String(input),
        method: init?.method ?? "GET",
        auth: new Headers(init?.headers).get("authorization"),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      };
      seen.push(entry);
      return responder(entry);
    }) as typeof fetch;
    return { http: new HttpBackend(env.CONTAINER_API_KEY, env.DB, now, fetchImpl), seen };
  }
  const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const register = (at = NOW) => saveEngine(env.DB, { url: ENGINE_URL, name: "pc" }, at);

  it("is unavailable until an engine registers, and again once its heartbeat goes stale", async () => {
    const t = { now: NOW };
    const { http } = backend(() => ok({}), () => t.now);
    expect(await http.available()).toBe(false);
    await register();
    expect(await http.available()).toBe(true);
    t.now = NOW + ENGINE_FRESH_SECONDS; // exactly at the limit: still fresh
    expect(await http.available()).toBe(true);
    t.now = NOW + ENGINE_FRESH_SECONDS + 1;
    expect(await http.available()).toBe(false);
  });

  it("raises BackendUnavailable (not a crash) when nothing is registered or the engine is stale", async () => {
    const { http, seen } = backend(() => ok({}));
    await expect(http.inspect("job1", "https://example.com/v", "corr")).rejects.toBeInstanceOf(BackendUnavailable);
    await register(NOW - ENGINE_FRESH_SECONDS - 5);
    await expect(http.inspect("job1", "https://example.com/v", "corr")).rejects.toThrow(/last seen/);
    expect(seen).toHaveLength(0); // nothing was sent to a stale URL
  });

  it("inspect: POST /inspect with the Bearer key and the URL, returns the engine's outcome", async () => {
    await register();
    const info: InspectResult = sampleInfo();
    const { http, seen } = backend(() => ok({ ok: true, data: { kind: "video", info } }));
    const outcome = await http.inspect("job1", "https://example.com/v", "corr-1");
    expect(outcome).toMatchObject({ ok: true, data: { kind: "video" } });
    expect(seen[0]).toMatchObject({ url: `${ENGINE_URL}/inspect`, method: "POST", auth: `Bearer ${env.CONTAINER_API_KEY}`, body: { url: "https://example.com/v", correlationId: "corr-1" } });
  });

  it("startJob sends the request unchanged; a refusal becomes BackendUnavailable", async () => {
    await register();
    const request = { jobId: "job-abc", url: "https://example.com/v" } as never;
    const good = backend((s) => ok({ jobId: (s.body as { jobId: string }).jobId, state: "running", phase: null, progress: null, result: null, errorCode: null, message: null }));
    expect(await good.http.startJob(request)).toMatchObject({ jobId: "job-abc", state: "running" });
    expect(good.seen[0]).toMatchObject({ url: `${ENGINE_URL}/jobs`, method: "POST", body: { jobId: "job-abc" } });

    const bad = backend(() => new Response("busy", { status: 503 }));
    await expect(bad.http.startJob(request)).rejects.toThrow(/HTTP 503/);
  });

  it("jobStatus is null when the engine is unreachable or does not know the job", async () => {
    await register();
    expect(await backend(() => ok({ error: "unknown" }, 404)).http.jobStatus("j1")).toBeNull();
    expect(
      await backend(() => {
        throw new TypeError("network down");
      }).http.jobStatus("j1"),
    ).toBeNull();
    const found = backend(() => ok({ jobId: "j1", state: "running", phase: "downloading", progress: null, result: null, errorCode: null, message: null }));
    expect((await found.http.jobStatus("j1"))?.state).toBe("running");
    expect(found.seen[0]).toMatchObject({ url: `${ENGINE_URL}/jobs/j1`, method: "GET" });
  });

  it("network failures surface as BackendUnavailable", async () => {
    await register();
    const { http } = backend(() => {
      throw new TypeError("fetch failed");
    });
    await expect(http.inspect("j", "https://example.com/v", "c")).rejects.toBeInstanceOf(BackendUnavailable);
  });

  it("cancel/release are best effort and use the right verbs", async () => {
    await register();
    const { http, seen } = backend(() => ok({ ok: true }));
    await http.cancel("j9");
    await http.release("j9");
    expect(seen.map((s) => `${s.method} ${s.url.replace(ENGINE_URL, "")}`)).toEqual(["POST /jobs/j9/cancel", "DELETE /jobs/j9"]);
    const down = backend(() => {
      throw new TypeError("offline");
    });
    await expect(down.http.cancel("j9")).resolves.toBeUndefined();
    await expect(down.http.release("j9")).resolves.toBeUndefined();
  });

  it("diagnostics merge in what the Worker knows about the engine", async () => {
    await register();
    const { http } = backend(() => ok({ ytdlp: "2026.10.21", mtproto: { ready: true } }));
    const d = await http.diagnostics();
    expect(d.ok).toBe(true);
    expect(d.detail).toMatchObject({ ytdlp: "2026.10.21", engine: { name: "pc", lastSeenSecondsAgo: 0 } });
  });
});

describe("bot behaviour in the hybrid profile", () => {
  const YT = "https://www.youtube.com/watch?v=hybrid123";

  it("tells the user the engine is offline instead of queueing work nobody will pick up", async () => {
    const h = makeHarness(FREE);
    Object.assign(h.backend, { available: async () => false });
    await send(h, userMessage(ALICE, YT));
    await h.runQueue();
    expect(h.tg.texts().at(-1)).toBe(messages("fa").engineOffline);
    expect(h.backend.inspectCalls).toHaveLength(0);
    expect((await h.deps.db.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>())!.n).toBe(0);
  });

  it("works normally once the engine is back", async () => {
    const h = makeHarness(FREE);
    let up = false;
    Object.assign(h.backend, { available: async () => up });
    await send(h, userMessage(ALICE, YT));
    up = true;
    await send(h, userMessage(ALICE, YT));
    await h.runQueue();
    expect((await latestJob(h, ALICE)).status).toBe("ready");
    expect(h.backend.inspectCalls).toHaveLength(1);
  });

  it("a 1080p download (310 MB) is delivered over MTProto and the job completes with that mode", async () => {
    const h = makeHarness(FREE);
    const job = await startDownload(h, ALICE);
    expect(job.status).toBe("downloading");
    expect(h.backend.started[0]!.selection).toMatchObject({ deliveryMode: "mtproto", allowLinkFallback: true, estimatedBytes: 310_000_000 });

    const done = await containerEvent(h, job, { type: "completed", result: directResult({ mode: "mtproto", sizeBytes: 309_800_000 }) });
    expect(done.status).toBe(200);
    expect(await reload(h, job)).toMatchObject({ status: "completed", delivery_mode: "mtproto" });
  });

  it("the Worker's event schema rejects an unknown delivery mode", async () => {
    const h = makeHarness(FREE);
    const job = await startDownload(h, ALICE);
    const res = await containerEvent(h, job, { type: "completed", result: { ...directResult(), mode: "carrier_pigeon" as never } });
    expect(res.status).toBe(400);
    expect((await reload(h, job)).status).toBe("downloading");
  });

  it("a small file still goes through the plain Bot API", async () => {
    const h = makeHarness(FREE);
    const job = await startDownload(h, ALICE, "144p");
    expect(h.backend.started[0]!.selection).toMatchObject({ deliveryMode: "bot_api_cloud" });
    await containerEvent(h, job, { type: "completed", result: directResult({ sizeBytes: 4_900_000 }) });
    expect(await reload(h, job)).toMatchObject({ status: "completed", delivery_mode: "bot_api_cloud" });
  });

  it("the delivery picker offers MTProto and hides the link option when R2 is absent", async () => {
    const cfg = testConfig(FREE);
    const m = messages("fa");
    const job = { short_id: "abc123" } as JobRow;
    const labels = deliveryKeyboard(m, job, "auto", cfg).inline_keyboard.flat().map((b) => b.text);
    expect(labels.some((t) => t.includes(m.deliveryLabels.mtproto!))).toBe(true);
    expect(labels.some((t) => t.includes(m.deliveryLabels.r2_link!))).toBe(false);
    expect(labels.some((t) => t.includes(m.deliveryLabels.bot_api_local!))).toBe(false);

    const paidLabels = deliveryKeyboard(m, job, "auto", testConfig()).inline_keyboard.flat().map((b) => b.text);
    expect(paidLabels.some((t) => t.includes(m.deliveryLabels.mtproto!))).toBe(false); // MTProto not enabled there
    expect(paidLabels.some((t) => t.includes(m.deliveryLabels.r2_link!))).toBe(true);
  });

  it("the delivery setting cycles auto → Bot API → MTProto → auto (no link, no local)", async () => {
    const h = makeHarness(FREE);
    await send(h, userMessage(ALICE, "/settings"));
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      await send(h, callback(ALICE, buttonData(h, "روش تحویل")));
      seen.push(allButtons(h).find((b) => b.text.includes("روش تحویل"))!.text);
    }
    expect(seen[0]).toContain("مستقیم تلگرام");
    expect(seen[1]).toContain("مستقیم (تا ۲ گیگ)");
    expect(seen[2]).toContain("خودکار");
  });
});

describe("replies to a message that no longer exists", () => {
  function scripted(failFirst: string) {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : { form: true };
      bodies.push(body);
      if (bodies.length === 1 && failFirst) return new Response(JSON.stringify({ ok: false, error_code: 400, description: failFirst }), { status: 400 });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7, chat: { id: 1 } } }));
    }) as typeof fetch;
    return { tg: new Telegram("123456:FAKE-TOKEN", fetchImpl), bodies };
  }

  it("sendMessage retries once without the reply target instead of failing", async () => {
    const { tg, bodies } = scripted("Bad Request: message to be replied not found");
    const sent = await tg.sendMessage(1, "hello", { reply_to_message_id: 999 });
    expect(sent.message_id).toBe(7);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ reply_to_message_id: 999 });
    expect(bodies[1]).not.toHaveProperty("reply_to_message_id");
    expect(bodies[1]).toMatchObject({ chat_id: 1, text: "hello" });
  });

  it("sendPhoto does the same", async () => {
    const { tg, bodies } = scripted("Bad Request: message to be replied not found");
    await tg.sendPhoto(1, "https://img.example.test/c.jpg", "cap", { reply_to_message_id: 5 });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).not.toHaveProperty("reply_to_message_id");
  });

  it("other 400s are still errors, and without a reply target nothing is retried", async () => {
    const other = scripted("Bad Request: chat not found");
    await expect(other.tg.sendMessage(1, "x", { reply_to_message_id: 5 })).rejects.toBeInstanceOf(TelegramError);
    expect(other.bodies).toHaveLength(1);

    const plain = scripted("Bad Request: message to be replied not found");
    await expect(plain.tg.sendMessage(1, "x")).rejects.toThrow(/replied not found/);
    expect(plain.bodies).toHaveLength(1);
  });

  it("the album upload also falls back to an unquoted send", async () => {
    const { tg, bodies } = scripted("Bad Request: message to be replied not found");
    await tg.sendPhotoAlbum(1, [{ bytes: new Uint8Array([1, 2, 3]), caption: "a" }], 42);
    expect(bodies).toHaveLength(2);
  });

  it("even if the status message cannot be sent at all, the job is still queued and inspected", async () => {
    const h = makeHarness(FREE);
    h.tg.failNext("sendMessage", 500, "Internal Server Error", 1);
    await send(h, userMessage(ALICE, "https://www.youtube.com/watch?v=nostatus1"));
    await h.runQueue();
    expect((await latestJob(h, ALICE)).status).toBe("ready");
    expect(h.backend.inspectCalls).toHaveLength(1);
  });

  it("a job is still queued for inspection when the user's message was deleted before the status reply", async () => {
    const h = makeHarness(FREE);
    h.tg.failNext("sendMessage", 400, "Bad Request: message to be replied not found", 1);
    await send(h, userMessage(ALICE, "https://www.youtube.com/watch?v=gone1234"));
    await h.runQueue();
    const job = await latestJob(h, ALICE);
    expect(job.status).toBe("ready");
    // the status message was delivered, just without quoting the deleted message
    const first = h.tg.of("sendMessage")[0]!;
    const retry = h.tg.of("sendMessage")[1]!;
    expect(first.params.reply_to_message_id).toBeDefined();
    expect(retry.params.reply_to_message_id).toBeUndefined();
  });
});

describe("no R2 bucket bound (free plan)", () => {
  async function withoutBucket() {
    const h = makeHarness(FREE);
    return { h, deps: { ...h.deps, bucket: null } };
  }

  it("R2 upload routes answer 501 instead of crashing", async () => {
    const { h, deps } = await withoutBucket();
    const job = await startDownload(h, ALICE);
    const token = await signJobToken(env.INTERNAL_SIGNING_SECRET, job.id);
    for (const route of ["create", "part", "complete", "abort"]) {
      const request = new Request(`https://tvd.example.test/internal/jobs/${job.id}/r2/${route}`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" });
      const res = await handleInternal(request, deps, new URL(request.url));
      expect(res!.status, route).toBe(501);
    }
  });

  it("job events still work without a bucket", async () => {
    const { h } = await withoutBucket();
    const job = await startDownload(h, ALICE);
    const res = await containerEvent(h, job, { type: "progress", progress: { phase: "downloading", percent: 10, speedBytesPerSec: 1_000_000, etaSeconds: 60, downloadedBytes: 1, totalBytes: 10, detail: null } });
    expect(res.status).toBe(200);
  });

  it("download links are disabled (valid signature or not)", async () => {
    const { deps } = await withoutBucket();
    const { signDownloadToken } = await import("../src/security/hmac");
    const token = await signDownloadToken(env.INTERNAL_SIGNING_SECRET, "job12345", NOW + 3600);
    const ok = new Request(`https://tvd.example.test/d/job12345/${token}/video.mp4`);
    const res = await handleDownload(ok, deps, new URL(ok.url));
    expect(res!.status).toBe(404);
    expect(await res!.text()).toMatch(/not enabled/);

    const forged = new Request("https://tvd.example.test/d/job12345/123.forged/video.mp4");
    expect((await handleDownload(forged, deps, new URL(forged.url)))!.status).toBe(410);
  });
});
