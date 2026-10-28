/**
 * Endpoints used by the media container and by users following a download link.
 *   POST /internal/jobs/:id/events          container progress / state / result (Bearer = HMAC(job id))
 *   POST /internal/jobs/:id/r2/create       start a multipart upload of the finished file
 *   PUT  /internal/jobs/:id/r2/part         upload one part
 *   POST /internal/jobs/:id/r2/complete     finish; returns the signed, expiring download URL
 *   POST /internal/jobs/:id/r2/abort
 *   GET|HEAD /d/:jobId/:token/:filename     download (Range supported, token expires)
 */
import { DELIVERY_MODES, ERROR_CODES, type ContainerEvent } from "@tvd/shared-types";
import { z } from "zod";
import type { Deps } from "../app";
import { getJob, jobIsTerminal, jobSelection } from "../db/jobs";
import type { JobRow } from "../db/types";
import { completeR2Object, getR2Object, getR2ObjectByJob, markR2Deleted, trackR2Object } from "../db/misc";
import { signDownloadToken, timingSafeEqual, verifyDownloadToken, verifyJobToken } from "../security/hmac";
import { EngineRegistrationSchema, saveEngine } from "../services/engine";
import { applyContainerEvent } from "../services/jobs";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const R2_PART_SIZE = 32 * 1024 * 1024;
const MAX_PART_BYTES = 64 * 1024 * 1024;
const UPLOAD_STATUSES = ["downloading", "processing", "uploading"];

const ErrorCodeSchema = z.enum(ERROR_CODES);
const ProgressSchema = z.object({
  phase: z.enum(["downloading", "processing", "uploading"]),
  percent: z.number().nullable(),
  speedBytesPerSec: z.number().nullable(),
  etaSeconds: z.number().nullable(),
  downloadedBytes: z.number().nullable(),
  totalBytes: z.number().nullable(),
  detail: z.string().nullable(),
});
const EventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("progress"), progress: ProgressSchema }),
  z.object({ type: z.literal("state"), status: z.enum(["downloading", "processing", "uploading"]) }),
  z.object({
    type: z.literal("completed"),
    result: z.object({
      mode: z.enum(DELIVERY_MODES),
      telegramMessageId: z.number().nullable(),
      telegramFileId: z.string().nullable(),
      sizeBytes: z.number(),
      filename: z.string(),
      durationSeconds: z.number().nullable(),
      width: z.number().nullable(),
      height: z.number().nullable(),
      downloadUrl: z.string().nullable(),
      downloadUrlExpiresAt: z.string().nullable(),
      sha256: z.string().nullable(),
    }),
  }),
  z.object({ type: z.literal("failed"), errorCode: ErrorCodeSchema, message: z.string(), retryable: z.boolean() }),
  z.object({ type: z.literal("heartbeat") }),
]);

async function authenticate(request: Request, deps: Deps, jobId: string): Promise<{ job: JobRow } | { error: Response }> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !(await verifyJobToken(deps.env.INTERNAL_SIGNING_SECRET, jobId, token))) return { error: json({ error: "unauthorized" }, 401) };
  const job = await getJob(deps.db, jobId);
  if (!job) return { error: json({ error: "unknown job" }, 404) };
  return { job };
}

/** `POST /internal/engine/register` — a self-hosted media engine announces (or withdraws) its tunnel URL. */
export async function handleEngineRegistration(request: Request, deps: Deps): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  const header = request.headers.get("authorization") ?? "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!supplied || !timingSafeEqual(supplied, deps.env.CONTAINER_API_KEY)) return json({ error: "unauthorized" }, 401);
  const body = EngineRegistrationSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return json({ error: "bad registration" }, 400);
  const outcome = await saveEngine(deps.db, body.data, deps.now());
  if (outcome === "rejected") return json({ error: "the engine URL must be a public https URL" }, 422);
  deps.log.info("engine registration", { outcome, name: body.data.name, active: body.data.activeJobs });
  return json({ ok: true, outcome });
}

export async function handleInternal(request: Request, deps: Deps, url: URL): Promise<Response | null> {
  if (url.pathname === "/internal/engine/register") return handleEngineRegistration(request, deps);
  const m = /^\/internal\/jobs\/([A-Za-z0-9_-]{8,64})\/(events|r2\/(?:create|part|complete|abort))$/.exec(url.pathname);
  if (!m) return null;
  const jobId = m[1]!;
  const route = m[2]!;
  const auth = await authenticate(request, deps, jobId);
  if ("error" in auth) return auth.error;
  const { job } = auth;
  const log = deps.log.child({ jobId, correlationId: job.correlation_id });

  if (route === "events") {
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    const parsed = EventSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json({ error: "bad event" }, 400);
    const result = await applyContainerEvent(deps, job, parsed.data as ContainerEvent);
    // tell the container to stop when the job was cancelled or has already reached a failed/cancelled end state
    const stop = result.cancel || (jobIsTerminal(job) && job.status !== "completed");
    return json({ ok: true, cancel: stop });
  }

  // ───── R2 multipart (the engine streams the finished file through us; it never holds R2 credentials) ─────
  const bucket = deps.bucket;
  if (!bucket) return json({ error: "link delivery is disabled: no R2 bucket is bound" }, 501);
  const selection = jobSelection(job);
  if (!UPLOAD_STATUSES.includes(job.status) || !selection) return json({ error: "job is not uploading" }, 409);
  if (selection.deliveryMode !== "r2_link" && !(selection as { allowLinkFallback?: boolean }).allowLinkFallback) return json({ error: "link delivery is not enabled for this job" }, 409);
  const now = deps.now();

  if (route === "r2/create") {
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    const body = z.object({ filename: z.string().min(1).max(200), size: z.number().int().positive(), contentType: z.string().max(100) }).safeParse(await request.json().catch(() => null));
    if (!body.success) return json({ error: "bad request" }, 400);
    if (body.data.size > deps.cfg.maxOutputBytes) return json({ error: "file exceeds the configured maximum" }, 413);
    const previous = await getR2ObjectByJob(deps.db, job.id, "delivery");
    if (previous) {
      // a retry of this job: drop the earlier (possibly half-written) object
      if (previous.upload_id) await bucket.resumeMultipartUpload(previous.object_key, previous.upload_id).abort().catch(() => undefined);
      await bucket.delete(previous.object_key).catch(() => undefined);
      await markR2Deleted(deps.db, previous.object_key, now);
    }
    const key = `deliveries/${job.id}/${crypto.randomUUID()}`;
    const upload = await bucket.createMultipartUpload(key, {
      httpMetadata: { contentType: body.data.contentType || "application/octet-stream" },
      customMetadata: { jobId: job.id, filename: body.data.filename },
    });
    await trackR2Object(deps.db, { key, jobId: job.id, purpose: "delivery", uploadId: upload.uploadId, expiresAt: now + deps.cfg.fileRetentionHours * 3600, now });
    log.info("r2 upload started", { key, size: body.data.size });
    return json({ uploadId: upload.uploadId, key, partSize: R2_PART_SIZE });
  }

  const tracked = await getR2ObjectByJob(deps.db, job.id, "delivery");
  const uploadId = url.searchParams.get("uploadId") ?? (route === "r2/part" ? "" : undefined);
  if (route === "r2/part") {
    if (request.method !== "PUT") return json({ error: "method not allowed" }, 405);
    const partNumber = Number(url.searchParams.get("part"));
    const length = Number(request.headers.get("content-length"));
    if (!tracked || tracked.upload_id !== uploadId) return json({ error: "unknown upload" }, 404);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) return json({ error: "bad part number" }, 400);
    if (!Number.isFinite(length) || length <= 0 || length > MAX_PART_BYTES || !request.body) return json({ error: "a fixed-length body up to 64 MiB is required" }, 400);
    const upload = bucket.resumeMultipartUpload(tracked.object_key, tracked.upload_id!);
    const part = await upload.uploadPart(partNumber, request.body);
    return json({ etag: part.etag });
  }

  const body = (await request.json().catch(() => ({}))) as { uploadId?: string; parts?: { partNumber: number; etag: string }[]; sha256?: string; size?: number };
  if (!tracked || !tracked.upload_id || tracked.upload_id !== body.uploadId) return json({ error: "unknown upload" }, 404);
  const upload = bucket.resumeMultipartUpload(tracked.object_key, tracked.upload_id);

  if (route === "r2/abort") {
    await upload.abort().catch(() => undefined);
    await bucket.delete(tracked.object_key).catch(() => undefined);
    await markR2Deleted(deps.db, tracked.object_key, now);
    return json({ ok: true });
  }

  // r2/complete
  if (!Array.isArray(body.parts) || body.parts.length === 0) return json({ error: "parts are required" }, 400);
  const object = await upload.complete(body.parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })));
  if (body.size !== undefined && object.size !== body.size) {
    await bucket.delete(tracked.object_key).catch(() => undefined);
    await markR2Deleted(deps.db, tracked.object_key, now);
    return json({ error: `stored size ${object.size} does not match the announced ${body.size}` }, 422);
  }
  await completeR2Object(deps.db, tracked.object_key, object.size, body.sha256 ?? null);
  const base = deps.cfg.publicBaseUrl;
  if (!base) return json({ error: "PUBLIC_BASE_URL is not configured" }, 500);
  const expires = tracked.expires_at;
  const token = await signDownloadToken(deps.env.INTERNAL_SIGNING_SECRET, job.id, expires);
  const filename = object.customMetadata?.filename ?? "video.mp4";
  log.info("r2 upload completed", { key: tracked.object_key, size: object.size });
  return json({ downloadUrl: `${base}/d/${job.id}/${token}/${encodeURIComponent(filename)}`, expiresAt: new Date(expires * 1000).toISOString() });
}

// ───────────────────────── public download route ─────────────────────────

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function handleDownload(request: Request, deps: Deps, url: URL): Promise<Response | null> {
  const bucket = deps.bucket;
  const m = /^\/d\/([A-Za-z0-9_-]{8,64})\/([0-9]+\.[A-Za-z0-9_-]+)\/([^/]+)$/.exec(url.pathname);
  if (!m) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405 });
  const [, jobId, token] = m as unknown as [string, string, string];
  if (!(await verifyDownloadToken(deps.env.INTERNAL_SIGNING_SECRET, jobId, token, deps.now()))) {
    return new Response("This download link is invalid or has expired.", { status: 410, headers: { "cache-control": "no-store" } });
  }
  if (!bucket) return new Response("Download links are not enabled.", { status: 404, headers: { "cache-control": "no-store" } });
  const tracked = await getR2ObjectByJob(deps.db, jobId, "delivery");
  const row = tracked ? await getR2Object(deps.db, tracked.object_key) : null;
  if (!row || row.deleted_at || row.size_bytes === null) return new Response("This file is no longer available.", { status: 404, headers: { "cache-control": "no-store" } });

  const headers = new Headers({
    "accept-ranges": "bytes",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
  if (request.method === "HEAD") {
    const head = await bucket.head(row.object_key);
    if (!head) return new Response("This file is no longer available.", { status: 404 });
    headers.set("content-length", String(head.size));
    headers.set("content-type", head.httpMetadata?.contentType ?? "application/octet-stream");
    headers.set("content-disposition", contentDisposition(head.customMetadata?.filename ?? "video.mp4"));
    return new Response(null, { status: 200, headers });
  }
  const wantsRange = request.headers.has("range");
  const object = await bucket.get(row.object_key, wantsRange ? { range: request.headers } : undefined);
  if (!object) return new Response("This file is no longer available.", { status: 404 });
  headers.set("content-type", object.httpMetadata?.contentType ?? "application/octet-stream");
  headers.set("content-disposition", contentDisposition(object.customMetadata?.filename ?? "video.mp4"));
  headers.set("etag", object.httpEtag);
  const body = "body" in object ? (object as R2ObjectBody).body : null;
  const range = (object as R2ObjectBody).range as { offset?: number; length?: number; suffix?: number } | undefined;
  if (wantsRange && range) {
    const offset = range.offset ?? Math.max(object.size - (range.suffix ?? 0), 0);
    const length = range.length ?? object.size - offset;
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("content-length", String(length));
    return new Response(body, { status: 206, headers });
  }
  headers.set("content-length", String(object.size));
  return new Response(body, { status: 200, headers });
}
