import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handleDownload, handleInternal } from "../src/internal/routes";
import { getR2ObjectByJob } from "../src/db/misc";
import type { JobRow } from "../src/db/types";
import { signJobToken, signDownloadToken } from "../src/security/hmac";
import { cleanupStorage } from "../src/services/cleanup";
import { ALICE, BOB, containerEvent, reload, startDownload } from "./flow-helpers";
import { makeHarness, type Harness } from "./helpers";

const BASE = "https://tvd.example.test";

async function internal(h: Harness, job: JobRow, path: string, init: RequestInit = {}, token?: string) {
  const request = new Request(`${BASE}/internal/jobs/${job.id}/${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token ?? (await signJobToken(env.INTERNAL_SIGNING_SECRET, job.id))}`, ...(init.headers ?? {}) },
  });
  const res = await handleInternal(request, h.deps, new URL(request.url));
  return res!;
}

const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** A job in `uploading` with link delivery (the 1080p option is too big for Telegram, so it is delivered as a link). */
async function uploadingJob(h: Harness): Promise<JobRow> {
  const job = await startDownload(h, ALICE, "1080p60");
  await containerEvent(h, job, { type: "state", status: "processing" });
  await containerEvent(h, job, { type: "state", status: "uploading" });
  return reload(h, job);
}

async function uploadFile(h: Harness, job: JobRow, parts: Uint8Array[]) {
  const created = await (await internal(h, job, "r2/create", post({ filename: "Big Buck Bunny.mp4", size: parts.reduce((s, p) => s + p.length, 0), contentType: "video/mp4" }))).json<any>();
  const etags: { partNumber: number; etag: string }[] = [];
  for (const [i, bytes] of parts.entries()) {
    const res = await internal(h, job, `r2/part?uploadId=${created.uploadId}&part=${i + 1}`, { method: "PUT", body: bytes, headers: { "content-length": String(bytes.length) } });
    expect(res.status).toBe(200);
    etags.push({ partNumber: i + 1, etag: (await res.json<any>()).etag });
  }
  return { created, etags };
}

const bytes = (n: number, seed = 7) => {
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = (i * 31 + seed) & 255;
  return a;
};

async function sha256(data: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("R2 multipart delivery through the Worker", () => {
  it("authenticates every call with the per-job token", async () => {
    const h = makeHarness();
    const job = await uploadingJob(h);
    expect((await internal(h, job, "r2/create", post({ filename: "a.mp4", size: 10, contentType: "video/mp4" }), "forged")).status).toBe(401);
    const other = await startDownload(h, BOB, "1080p60");
    const otherToken = await signJobToken(env.INTERNAL_SIGNING_SECRET, other.id);
    expect((await internal(h, job, "r2/create", post({ filename: "a.mp4", size: 10, contentType: "video/mp4" }), otherToken)).status).toBe(401);
  });

  it("only works for a running job for which link delivery is allowed", async () => {
    const h = makeHarness();
    const ready = await (await import("./flow-helpers")).submitAndInspect(h, ALICE); // not started yet
    expect((await internal(h, ready, "r2/create", post({ filename: "a.mp4", size: 10, contentType: "video/mp4" }))).status).toBe(409);
    const running = await startDownload(h, ALICE, "1080p60");
    await containerEvent(h, running, { type: "completed", result: (await import("./flow-helpers")).linkResult() });
    expect((await internal(h, await reload(h, running), "r2/create", post({ filename: "a.mp4", size: 10, contentType: "video/mp4" }))).status).toBe(409); // finished jobs cannot upload
    const direct = await startDownload(h, BOB, "144p"); // direct Telegram delivery *with* automatic link fallback
    await containerEvent(h, direct, { type: "state", status: "uploading" });
    expect((await internal(h, await reload(h, direct), "r2/create", post({ filename: "a.mp4", size: 10, contentType: "video/mp4" }))).status).toBe(200);
  });

  it("refuses files above the configured maximum", async () => {
    const h = makeHarness();
    const job = await uploadingJob(h);
    const res = await internal(h, job, "r2/create", post({ filename: "a.mp4", size: 1_900_000_001, contentType: "video/mp4" }));
    expect(res.status).toBe(413);
  });

  it("stores the parts, verifies the size and returns a signed, expiring link", { timeout: 30_000 }, async () => {
    const h = makeHarness();
    const job = await uploadingJob(h);
    const parts = [bytes(5 * 1024 * 1024), bytes(1234, 3)];
    const whole = new Uint8Array(parts[0]!.length + parts[1]!.length);
    whole.set(parts[0]!);
    whole.set(parts[1]!, parts[0]!.length);
    const { created, etags } = await uploadFile(h, job, parts);
    const done = await internal(h, job, "r2/complete", post({ uploadId: created.uploadId, parts: etags, sha256: await sha256(whole), size: whole.length }));
    expect(done.status).toBe(200);
    const { downloadUrl, expiresAt } = await done.json<any>();
    expect(downloadUrl).toMatch(/^https:\/\/tvd\.example\.test\/d\/job_[a-f0-9]+\/\d+\.[A-Za-z0-9_-]+\/Big%20Buck%20Bunny\.mp4$/);
    expect(new Date(expiresAt).getTime() / 1000).toBe(h.clock.now + 24 * 3600);
    const tracked = await getR2ObjectByJob(h.deps.db, job.id, "delivery");
    expect(tracked).toMatchObject({ size_bytes: whole.length, upload_id: null, sha256: await sha256(whole) });

    // download: full, ranged and HEAD
    const url = new URL(downloadUrl);
    const full = await handleDownload(new Request(url), h.deps, url);
    expect(full!.status).toBe(200);
    expect(full!.headers.get("content-disposition")).toContain("Big Buck Bunny.mp4");
    expect(full!.headers.get("cache-control")).toBe("private, no-store");
    const downloaded = new Uint8Array(await full!.arrayBuffer());
    expect(downloaded.length).toBe(whole.length);
    expect(await sha256(downloaded)).toBe(await sha256(whole)); // byte-for-byte identical
    const ranged = await handleDownload(new Request(url, { headers: { range: "bytes=10-19" } }), h.deps, url);
    expect(ranged!.status).toBe(206);
    expect(ranged!.headers.get("content-range")).toBe(`bytes 10-19/${whole.length}`);
    expect(new Uint8Array(await ranged!.arrayBuffer())).toEqual(whole.slice(10, 20));
    const tail = await handleDownload(new Request(url, { headers: { range: "bytes=-100" } }), h.deps, url);
    expect(tail!.status).toBe(206);
    expect(new Uint8Array(await tail!.arrayBuffer())).toEqual(whole.slice(-100));
    const head = await handleDownload(new Request(url, { method: "HEAD" }), h.deps, url);
    expect(head!.headers.get("content-length")).toBe(String(whole.length));
    expect(await handleDownload(new Request(url, { method: "POST" }), h.deps, url).then((r) => r!.status)).toBe(405);
  });

  it("rejects forged, tampered and expired download links", async () => {
    const h = makeHarness();
    const job = await uploadingJob(h);
    const { created, etags } = await uploadFile(h, job, [bytes(500)]);
    const done = await (await internal(h, job, "r2/complete", post({ uploadId: created.uploadId, parts: etags, size: 500 }))).json<any>();
    const url = new URL(done.downloadUrl);
    const get = (u: URL) => handleDownload(new Request(u), h.deps, u).then((r) => r!.status);
    expect(await get(url)).toBe(200);
    const [, , jobId, token, file] = url.pathname.split("/") as [string, string, string, string, string];
    const [exp, sig] = token.split(".") as [string, string];
    expect(await get(new URL(`${BASE}/d/${jobId}/${exp}.${sig.slice(0, -2)}xx/${file}`))).toBe(410); // tampered signature
    expect(await get(new URL(`${BASE}/d/${jobId}/${Number(exp) + 99999}.${sig}/${file}`))).toBe(410); // extended expiry
    expect(await get(new URL(`${BASE}/d/${ALICE}${BOB}xxxx/${token}/${file}`))).toBe(410); // token belongs to another job
    expect(await get(new URL(`${BASE}/d/${jobId}/${await signDownloadToken(env.INTERNAL_SIGNING_SECRET, jobId, h.clock.now - 5)}/${file}`))).toBe(410); // expired
    h.advance(24 * 3600 + 5);
    expect(await get(url)).toBe(410); // our own link expires too
  });

  it("detects a size mismatch and deletes the object", async () => {
    const h = makeHarness();
    const job = await uploadingJob(h);
    const { created, etags } = await uploadFile(h, job, [bytes(1000)]);
    const res = await internal(h, job, "r2/complete", post({ uploadId: created.uploadId, parts: etags, size: 999 }));
    expect(res.status).toBe(422);
    expect(await env.MEDIA_BUCKET.head(created.key)).toBeNull();
    expect((await getR2ObjectByJob(h.deps.db, job.id, "delivery"))).toBeNull();
  });

  it("aborts an upload and a retry replaces the earlier half-written object", async () => {
    const h = makeHarness();
    const job = await uploadingJob(h);
    const first = await (await internal(h, job, "r2/create", post({ filename: "a.mp4", size: 5, contentType: "video/mp4" }))).json<any>();
    const aborted = await internal(h, job, "r2/abort", post({ uploadId: first.uploadId }));
    expect(aborted.status).toBe(200);
    expect(await getR2ObjectByJob(h.deps.db, job.id, "delivery")).toBeNull();
    const second = await (await internal(h, job, "r2/create", post({ filename: "a.mp4", size: 5, contentType: "video/mp4" }))).json<any>();
    const third = await (await internal(h, job, "r2/create", post({ filename: "a.mp4", size: 5, contentType: "video/mp4" }))).json<any>(); // retry
    expect(third.key).not.toBe(second.key);
    expect(await getR2ObjectByJob(h.deps.db, job.id, "delivery").then((r) => r!.object_key)).toBe(third.key);
  });

  it("rejects bad part uploads", async () => {
    const h = makeHarness();
    const job = await uploadingJob(h);
    const created = await (await internal(h, job, "r2/create", post({ filename: "a.mp4", size: 5, contentType: "video/mp4" }))).json<any>();
    const put = (qs: string, body: BodyInit | null, headers: Record<string, string> = {}) => internal(h, job, `r2/part?${qs}`, { method: "PUT", body, headers });
    expect((await put("uploadId=wrong&part=1", bytes(10), { "content-length": "10" })).status).toBe(404);
    expect((await put(`uploadId=${created.uploadId}&part=0`, bytes(10), { "content-length": "10" })).status).toBe(400);
    expect((await put(`uploadId=${created.uploadId}&part=1`, null)).status).toBe(400);
    expect((await internal(h, job, `r2/part?uploadId=${created.uploadId}&part=1`, { method: "POST", body: "x" })).status).toBe(405);
  });

  it("deleting expired objects and abandoned uploads is part of cleanup", async () => {
    const h = makeHarness();
    const job = await uploadingJob(h);
    const { created, etags } = await uploadFile(h, job, [bytes(300)]);
    await internal(h, job, "r2/complete", post({ uploadId: created.uploadId, parts: etags, size: 300 }));
    expect(await env.MEDIA_BUCKET.head(created.key)).not.toBeNull();
    expect(await cleanupStorage(h.deps)).toEqual({ expiredObjectsDeleted: 0, abandonedUploadsAborted: 0 });
    h.advance(24 * 3600 + 1);
    expect(await cleanupStorage(h.deps)).toMatchObject({ expiredObjectsDeleted: 1 });
    expect(await env.MEDIA_BUCKET.head(created.key)).toBeNull();

    // an upload whose job died mid-way
    const job2 = await startDownload(h, BOB, "1080p60");
    await containerEvent(h, job2, { type: "state", status: "uploading" });
    const stale = await (await internal(h, await reload(h, job2), "r2/create", post({ filename: "x.mp4", size: 5, contentType: "video/mp4" }))).json<any>();
    h.advance(7 * 3600);
    const report = await cleanupStorage(h.deps);
    expect(report.abandonedUploadsAborted + report.expiredObjectsDeleted).toBeGreaterThanOrEqual(1);
    expect(await env.MEDIA_BUCKET.head(stale.key)).toBeNull();
  });
});
