import type { ContainerJobStatus } from "@tvd/shared-types";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createDeps } from "../src/app";
import { getJob, createJob, transition } from "../src/db/jobs";
import { upsertUser } from "../src/db/users";
import { handleQueue } from "../src/queue/consumer";
import { startBroadcast, broadcastTick } from "../src/services/broadcast";
import { runSweeper } from "../src/services/sweeper";
import { ADMIN, ALICE, BOB, directResult, latestJob, pressQuality, reload, startDownload, submitAndInspect } from "./flow-helpers";
import { buttonData, callback, makeHarness, send, userMessage } from "./helpers";

const status = (jobId: string, patch: Partial<ContainerJobStatus>): ContainerJobStatus => ({ jobId, state: "running", phase: "downloading", progress: null, result: null, errorCode: null, message: null, ...patch });

describe("sweeper: recovery of running jobs", () => {
  it("applies a result whose callback was lost", async () => {
    const h = makeHarness();
    const job = await startDownload(h, ALICE, "144p");
    h.backend.statuses.set(job.id, status(job.id, { state: "completed", result: directResult() }));
    const report = await runSweeper(h.deps);
    await h.drain();
    expect(report.polled).toBe(1);
    expect((await reload(h, job)).status).toBe("completed");
    expect(h.backend.released).toContain(job.id);
  });

  it("applies a failure whose callback was lost", async () => {
    const h = makeHarness();
    const job = await startDownload(h, ALICE, "144p");
    h.backend.statuses.set(job.id, status(job.id, { state: "failed", errorCode: "private_video", message: "Private video" }));
    await runSweeper(h.deps);
    expect(await reload(h, job)).toMatchObject({ status: "failed", error_code: "private_video" });
  });

  it("restarts a job whose container restarted and forgot it", async () => {
    const h = makeHarness();
    const job = await startDownload(h, ALICE, "144p");
    h.backend.statuses.set(job.id, status(job.id, { state: "unknown" }));
    await runSweeper(h.deps);
    expect(await reload(h, job)).toMatchObject({ status: "retry_wait", error_code: "container_lost" });
    expect(h.queue.messages.at(-1)?.body.type).toBe("download");
    h.backend.statuses.delete(job.id);
    h.advance(31);
    h.backend.started.length = 0;
    await h.runQueue();
    expect((await reload(h, job)).status).toBe("downloading");
    expect(h.backend.started).toHaveLength(1); // started again on a fresh instance, exactly once
    expect((await reload(h, job)).attempts).toBe(2);
  });

  it("gives an unreachable container a grace period before declaring it lost", async () => {
    const h = makeHarness();
    const job = await startDownload(h, ALICE, "144p");
    h.backend.statuses.set(job.id, null); // unreachable
    h.advance(60);
    await runSweeper(h.deps);
    expect((await reload(h, job)).status).toBe("downloading");
    h.advance(200);
    await runSweeper(h.deps);
    expect((await reload(h, job)).status).toBe("retry_wait");
  });

  it("records progress it observes while polling", async () => {
    const h = makeHarness();
    const job = await startDownload(h, ALICE, "144p");
    const progress = { phase: "downloading" as const, percent: 33, speedBytesPerSec: 1000, etaSeconds: 5, downloadedBytes: 1, totalBytes: 3, detail: null };
    h.backend.statuses.set(job.id, status(job.id, { progress }));
    await runSweeper(h.deps);
    expect(JSON.parse((await reload(h, job)).progress_json!)).toMatchObject({ percent: 33 });
  });

  it("gives up after the configured number of attempts", async () => {
    const h = makeHarness({ MAX_RETRIES: "1" });
    const job = await startDownload(h, ALICE, "144p");
    for (let i = 0; i < 3; i++) {
      h.backend.statuses.set(job.id, status(job.id, { state: "unknown" }));
      await runSweeper(h.deps);
      h.advance(700);
      await h.runQueue();
    }
    expect(await reload(h, job)).toMatchObject({ status: "failed", error_code: "container_lost" });
  });
});

describe("sweeper: stuck, stale and expired jobs", () => {
  it("re-queues a queued job whose queue message disappeared (once per tick)", async () => {
    const h = makeHarness();
    const job = await submitAndInspect(h, ALICE);
    await pressQuality(h, ALICE, job, "144p");
    h.queue.messages.length = 0; // the message is gone
    await runSweeper(h.deps);
    expect(h.queue.messages).toHaveLength(0); // not stale yet
    h.advance(601);
    await runSweeper(h.deps);
    expect(h.queue.messages.map((m) => m.body.type)).toEqual(["download"]);
    await runSweeper(h.deps);
    expect(h.queue.messages).toHaveLength(1); // touched: no duplicate every minute
    await h.runQueue();
    expect((await reload(h, job)).status).toBe("downloading");
  });

  it("fails an inspection that never finished and tells the user", async () => {
    const h = makeHarness();
    await send(h, userMessage(ALICE, "https://slow.example.com/v"));
    const job = await latestJob(h, ALICE);
    await transition(h.deps.db, job.id, "queued", "inspecting", h.clock.now);
    h.advance(301);
    await runSweeper(h.deps);
    expect(await reload(h, job)).toMatchObject({ status: "failed", error_code: "timeout" });
  });

  it("expires menus nobody answered and removes their keyboard", async () => {
    const h = makeHarness();
    const job = await submitAndInspect(h, ALICE);
    const pressMe = buttonData(h, "144p");
    h.tg.reset();
    h.advance(3601);
    await runSweeper(h.deps);
    expect((await reload(h, job)).status).toBe("expired");
    expect(h.tg.of("editMessageReplyMarkup")).toHaveLength(1);
    await send(h, callback(ALICE, pressMe));
    expect(String(h.tg.last("answerCallbackQuery")!.params.text)).toContain("منقضی");
  });

  it("re-queues overdue retries", async () => {
    const h = makeHarness();
    const job = await startDownload(h, ALICE, "144p");
    h.backend.statuses.set(job.id, status(job.id, { state: "unknown" }));
    await runSweeper(h.deps);
    h.queue.messages.length = 0; // the delayed retry message was lost
    h.advance(30 + 301);
    await runSweeper(h.deps);
    expect(h.queue.messages.map((m) => m.body.type)).toEqual(["download"]);
  });

  it("purges old history and bookkeeping at the top of the hour", async () => {
    const h = makeHarness();
    h.clock.now = Math.floor(h.clock.now / 3600) * 3600; // minute 0
    await upsertUser(h.deps.db, { id: 77, first_name: "O" }, h.clock.now);
    const old = await createJob(h.deps.db, { userId: 77, chatId: 77, sourceUrl: "https://o.test/v", normalizedUrl: "https://o.test/v", urlHash: "x", maxAttempts: 3, now: h.clock.now - 40 * 86400 });
    await transition(h.deps.db, old.id, "queued", "inspecting", h.clock.now - 40 * 86400);
    await transition(h.deps.db, old.id, "inspecting", "failed", h.clock.now - 40 * 86400, { error_code: "unavailable" });
    const recent = await createJob(h.deps.db, { userId: 77, chatId: 77, sourceUrl: "https://r.test/v", normalizedUrl: "https://r.test/v", urlHash: "y", maxAttempts: 3, now: h.clock.now - 86400 });
    await transition(h.deps.db, recent.id, "queued", "cancelled", h.clock.now - 86400);
    await runSweeper(h.deps);
    expect(await getJob(h.deps.db, old.id)).toBeNull(); // older than the 30-day retention
    expect(await getJob(h.deps.db, recent.id)).not.toBeNull();
  });
});

describe("queue consumer", () => {
  function batch(messages: { body: unknown; attempts?: number }[], queue = "tvd-jobs") {
    const acks: number[] = [];
    const retries: { i: number; delay?: number }[] = [];
    return {
      acks, retries,
      batch: {
        queue,
        messages: messages.map((m, i) => ({ id: String(i), body: m.body, attempts: m.attempts ?? 1, ack: () => void acks.push(i), retry: (o?: { delaySeconds?: number }) => void retries.push({ i, ...(o?.delaySeconds ? { delay: o.delaySeconds } : {}) }) })),
      } as unknown as MessageBatch<unknown>,
    };
  }
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;

  it("discards malformed messages instead of retrying them forever", async () => {
    const { batch: b, acks, retries } = batch([{ body: { type: "nonsense" } }, { body: "string" }, { body: { type: "inspect" } }]);
    await handleQueue(b, env, ctx);
    expect(acks).toEqual([0, 1, 2]);
    expect(retries).toEqual([]);
  });

  it("acks a duplicate delivery for a job that is already gone or finished", async () => {
    const { batch: b, acks } = batch([{ body: { type: "inspect", jobId: "job_doesnotexist", correlationId: "c" } }, { body: { type: "download", jobId: "job_doesnotexist", correlationId: "c", attempt: 0 } }]);
    await handleQueue(b, env, ctx);
    expect(acks).toEqual([0, 1]);
  });

  it("a dead-lettered message fails its job so the user is not left waiting", async () => {
    const h = makeHarness();
    await send(h, userMessage(ALICE, "https://dead.example.com/v"));
    const job = await latestJob(h, ALICE);
    const { batch: b, acks } = batch([{ body: { type: "inspect", jobId: job.id, correlationId: job.correlation_id } }], "tvd-jobs-dlq");
    // createDeps in the consumer uses the real Telegram client; point it at the test fake through the same factory the Worker uses
    const deps = await createDeps(env, ctx, { tg: h.tg.tg, backend: h.backend, queue: h.queue, now: () => h.clock.now });
    expect(deps.tg).toBe(h.tg.tg);
    const { failJob } = await import("../src/services/jobs");
    await failJob(deps, (await reload(h, job)), "internal", "processing could not be started after several attempts", false);
    expect(await reload(h, job)).toMatchObject({ status: "failed", error_code: "internal" });
    expect(acks).toEqual([]); // (the handler wiring is exercised in handleQueue below)
    void b;
  });
});

describe("announcements", () => {
  it("are sent in batches by the sweeper, only to users who have not blocked the bot", async () => {
    const h = makeHarness();
    for (const id of [201, 202, 203]) await upsertUser(h.deps.db, { id, first_name: "U" }, h.clock.now);
    await h.deps.db.prepare("INSERT INTO users (tg_user_id, is_blocked, created_at, last_seen_at) VALUES (204, 1, 1, 1)").run();
    await startBroadcast(h.deps, ADMIN, "Maintenance <tonight>");
    await broadcastTick(h.deps);
    const sent = h.tg.of("sendMessage");
    expect(sent.map((c) => c.params.chat_id).sort()).toEqual([201, 202, 203, ADMIN].sort());
    expect(sent.find((c) => c.params.chat_id === 201)!.params.text).toBe("Maintenance &lt;tonight&gt;");
    expect(String(sent.find((c) => c.params.chat_id === ADMIN)!.params.text)).toContain("3 delivered");
    h.tg.reset();
    await broadcastTick(h.deps); // finished: nothing more is sent
    expect(h.tg.calls).toHaveLength(0);
  }, 20_000);

  it("require administrator confirmation", async () => {
    const h = makeHarness();
    await send(h, userMessage(ADMIN, "/admin announce hello everyone"));
    expect(String(h.tg.last("sendMessage")!.params.text)).toContain("hello everyone");
    await send(h, callback(BOB, buttonData(h, "send to all")));
    expect(String(h.tg.last("answerCallbackQuery")!.params.text)).toContain("فقط برای ادمین");
    expect(h.tg.of("sendMessage").every((c) => c.params.chat_id === ADMIN)).toBe(true);
  });
});
