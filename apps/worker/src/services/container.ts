import type { ContainerJobStatus, ContainerStartJobRequest, InspectResult } from "@tvd/shared-types";
import { getContainer } from "@cloudflare/containers";
import type { Config } from "../config";
import type { ErrorCode } from "@tvd/shared-types";
import type { MediaJob } from "../durable/containers";

export interface BackendError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export type InspectOutcome =
  | { ok: true; data: { kind: "video"; info: InspectResult } | { kind: "playlist"; title: string | null; total: number; entries: { index: number; title: string; url: string; durationSeconds: number | null }[] } }
  | { ok: false; error: BackendError };

export type FramesOutcome = { ok: true; frames: { timestamp: number; jpegBase64: string }[] } | { ok: false; error: BackendError };

/** Everything the Worker needs from the media containers. Tests inject a fake implementation. */
export interface MediaBackend {
  inspect(jobId: string, url: string, correlationId: string): Promise<InspectOutcome>;
  frames(jobId: string, url: string, formatId: string, durationSeconds: number | null, count: number): Promise<FramesOutcome>;
  /** Start (idempotently) a download job. Throws BackendUnavailable if the container cannot be reached. */
  startJob(request: ContainerStartJobRequest): Promise<ContainerJobStatus>;
  /** Current status, or null when the container is unreachable. state "unknown" = it restarted and lost the job. */
  jobStatus(jobId: string): Promise<ContainerJobStatus | null>;
  cancel(jobId: string): Promise<void>;
  /** Stop the job's container (frees disk and stops billing). Never throws. */
  release(jobId: string): Promise<void>;
  diagnostics(): Promise<{ ok: boolean; detail: unknown }>;
  /** Can new work be accepted right now? (A self-hosted engine may be offline.) Absent = always yes. */
  available?(): Promise<boolean>;
}

export class BackendUnavailable extends Error {}

async function fnv(text: string): Promise<number> {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export class MediaClient implements MediaBackend {
  constructor(
    private readonly env: Env,
    private readonly cfg: Pick<Config, "inspectorPoolSize">,
  ) {}

  private inspectorFor(jobId: string) {
    return fnv(jobId).then((h) => getContainer(this.env.MEDIA_INSPECTOR, `inspector-${h % this.cfg.inspectorPoolSize}`));
  }

  private jobStub(jobId: string) {
    return getContainer(this.env.MEDIA_JOB, jobId);
  }

  private async send(stub: { fetch(request: Request): Promise<Response> }, path: string, init: { method?: string; body?: unknown } = {}, timeoutMs = 30_000): Promise<Response> {
    const headers = new Headers({ authorization: `Bearer ${this.env.CONTAINER_API_KEY}` });
    let body: string | undefined;
    if (init.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.body);
    }
    const request = new Request(`http://container${path}`, { method: init.method ?? (body ? "POST" : "GET"), headers, ...(body ? { body } : {}), signal: AbortSignal.timeout(timeoutMs) });
    try {
      return await stub.fetch(request);
    } catch (error) {
      throw new BackendUnavailable(error instanceof Error ? error.message : String(error));
    }
  }

  async inspect(jobId: string, url: string, correlationId: string): Promise<InspectOutcome> {
    const res = await this.send(await this.inspectorFor(jobId), "/inspect", { body: { url, correlationId } }, 150_000);
    return this.parse<InspectOutcome>(res);
  }

  async frames(jobId: string, url: string, formatId: string, durationSeconds: number | null, count: number): Promise<FramesOutcome> {
    const res = await this.send(await this.inspectorFor(jobId), "/frames", { body: { url, formatId, durationSeconds, count } }, 170_000);
    const body = await this.parse<{ ok: boolean; data?: { frames: { timestamp: number; jpegBase64: string }[] }; error?: BackendError }>(res);
    return body.ok && body.data ? { ok: true, frames: body.data.frames } : { ok: false, error: body.error ?? { code: "internal", message: "frames failed", retryable: false } };
  }

  async startJob(request: ContainerStartJobRequest): Promise<ContainerJobStatus> {
    const res = await this.send(this.jobStub(request.jobId), "/jobs", { body: request }, 120_000);
    if (res.status >= 400) throw new BackendUnavailable(`container rejected the job: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as ContainerJobStatus;
  }

  async jobStatus(jobId: string): Promise<ContainerJobStatus | null> {
    try {
      const res = await this.send(this.jobStub(jobId), `/jobs/${jobId}`, {}, 20_000);
      if (!res.ok) return null;
      return (await res.json()) as ContainerJobStatus;
    } catch {
      return null;
    }
  }

  async cancel(jobId: string): Promise<void> {
    try {
      await this.send(this.jobStub(jobId), `/jobs/${jobId}/cancel`, { method: "POST" }, 15_000);
    } catch {
      /* unreachable container: the job is already marked cancelled in D1 and the instance will be released */
    }
  }

  async release(jobId: string): Promise<void> {
    try {
      const stub = this.jobStub(jobId) as unknown as DurableObjectStub<MediaJob>;
      await stub.shutdown();
    } catch {
      /* already gone */
    }
  }

  async diagnostics(): Promise<{ ok: boolean; detail: unknown }> {
    try {
      const res = await this.send(await this.inspectorFor("diagnostics"), "/diagnostics", {}, 60_000);
      return { ok: res.ok, detail: res.ok ? await res.json() : `HTTP ${res.status}` };
    } catch (error) {
      return { ok: false, detail: String(error) };
    }
  }

  private async parse<T>(res: Response): Promise<T> {
    if (!res.ok) throw new BackendUnavailable(`container returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }
}
