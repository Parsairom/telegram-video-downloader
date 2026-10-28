import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { countRunning, createJob, getJob, listEvents, patchJob, transition } from "../src/db/jobs";
import { claimUpdate, rateLimit, setAppConfig, getAppConfig, trackR2Object, listExpiredR2Objects, markR2Deleted } from "../src/db/misc";
import { getUser, readUserState, setUserState, updateSettings, upsertUser } from "../src/db/users";
import { parseSettings } from "../src/db/types";

const db = env.DB;
const NOW = 1_760_000_000;

async function newJob(userId = 1) {
  await upsertUser(db, { id: userId, first_name: "T" }, NOW);
  return createJob(db, { userId, chatId: userId, sourceUrl: "https://e.test/v", normalizedUrl: "https://e.test/v", urlHash: `h${Math.random()}`, maxAttempts: 3, now: NOW });
}

describe("job transitions are compare-and-set", () => {
  it("applies a legal transition once and records an audit event", async () => {
    const job = await newJob();
    expect(job.status).toBe("queued");
    expect(await transition(db, job.id, "queued", "inspecting", NOW + 1)).toBe(true);
    expect(await transition(db, job.id, "queued", "inspecting", NOW + 2)).toBe(false); // a duplicate delivery loses the race
    const events = await listEvents(db, job.id);
    expect(events.map((e) => `${e.from_status ?? "none"}>${e.to_status}`)).toEqual(["none>queued", "queued>inspecting"]);
  });

  it("refuses illegal transitions before touching the database", async () => {
    const job = await newJob();
    await expect(transition(db, job.id, "queued", "completed", NOW)).rejects.toThrow(/illegal transition/);
    await expect(transition(db, job.id, "queued", "uploading", NOW)).rejects.toThrow(/illegal transition/);
    expect((await getJob(db, job.id))!.status).toBe("queued");
  });

  it("concurrent identical transitions: exactly one wins and exactly one audit row exists", async () => {
    const job = await newJob();
    const results = await Promise.all([1, 2, 3, 4, 5].map((i) => transition(db, job.id, "queued", "inspecting", NOW + i)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const events = (await listEvents(db, job.id)).filter((e) => e.to_status === "inspecting");
    expect(events).toHaveLength(1);
  });

  it("sets finished_at on terminal states and applies patches atomically", async () => {
    const job = await newJob();
    await transition(db, job.id, "queued", "inspecting", NOW + 1);
    await transition(db, job.id, "inspecting", "failed", NOW + 5, { error_code: "unavailable", error_message: "gone" });
    const row = (await getJob(db, job.id))!;
    expect(row).toMatchObject({ status: "failed", error_code: "unavailable", error_message: "gone", finished_at: NOW + 5 });
    // a failed job may be retried manually, and then it is no longer finished
    expect(await transition(db, job.id, "failed", "queued", NOW + 9, { finished_at: null, error_code: null })).toBe(true);
    expect((await getJob(db, job.id))!.finished_at).toBeNull();
  });

  it("never writes unknown columns", async () => {
    const job = await newJob();
    await expect(transition(db, job.id, "queued", "inspecting", NOW, { ["status; DROP TABLE jobs; --"]: 1 } as never)).rejects.toThrow(/illegal job column/);
    await expect(patchJob(db, job.id, { ["evil"]: 1 } as never, NOW)).rejects.toThrow(/illegal job column/);
    expect((await getJob(db, job.id))!.status).toBe("queued");
  });

  it("enforces global concurrency atomically with the capacity guard", async () => {
    const jobs = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => newJob(100 + i)));
    for (const j of jobs) {
      await transition(db, j.id, "queued", "inspecting", NOW);
      await transition(db, j.id, "inspecting", "ready", NOW);
      await transition(db, j.id, "ready", "queued", NOW);
    }
    const before = await countRunning(db);
    const room = 3;
    const claimed = await Promise.all(jobs.map((j) => transition(db, j.id, "queued", "downloading", NOW + 1, {}, null, { maxRunning: before + room })));
    expect(claimed.filter(Boolean)).toHaveLength(room);
    expect(await countRunning(db)).toBe(before + room);
  });
});

describe("webhook idempotency, rate limits, config", () => {
  it("claims an update id only once", async () => {
    expect(await claimUpdate(db, 424242, NOW)).toBe(true);
    expect(await claimUpdate(db, 424242, NOW)).toBe(false);
  });

  it("limits per window and recovers in the next window", async () => {
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await rateLimit(db, "t:a", 3, 60, NOW));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false, false]);
    expect(results[3]!.retryAfterSeconds).toBeGreaterThan(0);
    expect((await rateLimit(db, "t:a", 3, 60, NOW + 61)).allowed).toBe(true);
    expect((await rateLimit(db, "t:other", 3, 60, NOW)).allowed).toBe(true); // separate keys do not interfere
  });

  it("stores and reads runtime configuration", async () => {
    await setAppConfig(db, "max_jobs_per_user", "5", 1, NOW);
    expect((await getAppConfig(db)).max_jobs_per_user).toBe("5");
  });
});

describe("users, settings and conversation state", () => {
  it("merges and validates settings, falling back to defaults on garbage", async () => {
    await upsertUser(db, { id: 55, first_name: "S" }, NOW);
    const s = await updateSettings(db, 55, { defaultResolution: "720", quickStart: false });
    expect(s).toMatchObject({ defaultResolution: "720", quickStart: false, thumbnailMode: "original" });
    const row = (await getUser(db, 55))!;
    expect(parseSettings(row.settings_json).defaultResolution).toBe("720");
    expect(parseSettings("{not json").defaultResolution).toBe("ask");
    expect(parseSettings('{"defaultResolution":"4k"}').defaultResolution).toBe("ask");
  });

  it("expires a pending text prompt after 15 minutes", async () => {
    const user = await upsertUser(db, { id: 56, first_name: "S" }, NOW);
    await setUserState(db, 56, { kind: "await_title", jobShortId: "abcdef1234" }, NOW);
    const fresh = (await getUser(db, 56))!;
    expect(readUserState(fresh, NOW + 60)).toMatchObject({ kind: "await_title" });
    expect(readUserState(fresh, NOW + 16 * 60)).toBeNull();
    expect(user.tg_user_id).toBe(56);
  });
});

describe("R2 bookkeeping", () => {
  it("lists only objects past their expiry that are not yet deleted", async () => {
    await trackR2Object(db, { key: "deliveries/j1/a", jobId: "j1", purpose: "delivery", expiresAt: NOW - 10, now: NOW - 100 });
    await trackR2Object(db, { key: "deliveries/j2/b", jobId: "j2", purpose: "delivery", expiresAt: NOW + 1000, now: NOW });
    const expired = (await listExpiredR2Objects(db, NOW)).map((r) => r.object_key);
    expect(expired).toContain("deliveries/j1/a");
    expect(expired).not.toContain("deliveries/j2/b");
    await markR2Deleted(db, "deliveries/j1/a", NOW);
    expect((await listExpiredR2Objects(db, NOW)).map((r) => r.object_key)).not.toContain("deliveries/j1/a");
  });
});
