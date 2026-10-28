/**
 * Self-hosted media engine (free Cloudflare plan: no Containers).
 *
 * The engine runs on your own machine behind a Cloudflare Tunnel. Its public URL changes whenever the tunnel restarts, so
 * the engine registers itself (`POST /internal/engine/register`, authenticated with CONTAINER_API_KEY) on start-up and every
 * 30 s. The Worker stores the registration in D1 and only sends work to an engine that was seen in the last two minutes.
 * The HTTP API it speaks is exactly the container API (apps/media-container/app/api.py).
 */
import type { ContainerJobStatus, ContainerStartJobRequest } from "@tvd/shared-types";
import { z } from "zod";
import { deleteAppConfig, getAppConfig, setAppConfig } from "../db/misc";
import { BackendUnavailable, type FramesOutcome, type InspectOutcome, type MediaBackend } from "./container";

export const ENGINE_KEY = "engine";
export const ENGINE_FRESH_SECONDS = 120;

export const EngineRegistrationSchema = z.object({
  url: z.string().url().nullable(),
  name: z.string().max(80).optional(),
  ytdlp: z.string().max(40).optional(),
  activeJobs: z.number().int().nonnegative().optional(),
  maxConcurrentJobs: z.number().int().positive().optional(),
  capabilities: z.object({ mtproto: z.boolean().default(false), localBotApi: z.boolean().default(false) }).optional(),
});

export interface EngineRecord {
  url: string;
  name: string;
  ytdlp: string | null;
  activeJobs: number;
  maxConcurrentJobs: number | null;
  capabilities: { mtproto: boolean; localBotApi: boolean };
  lastSeen: number;
}

/** The URL must be https on a public host — a registration can never point the Worker at an internal address. */
export function isAcceptableEngineUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password) return false;
    const host = u.hostname.toLowerCase();
    return host.includes(".") && !host.endsWith(".local") && !host.endsWith(".internal") && !/^[\d.]+$/.test(host) && !host.startsWith("[");
  } catch {
    return false;
  }
}

export async function saveEngine(db: D1Database, reg: z.infer<typeof EngineRegistrationSchema>, now: number): Promise<"registered" | "removed" | "rejected"> {
  if (reg.url === null) {
    await deleteAppConfig(db, ENGINE_KEY);
    return "removed";
  }
  if (!isAcceptableEngineUrl(reg.url)) return "rejected";
  const record: EngineRecord = {
    url: reg.url.replace(/\/+$/, ""),
    name: reg.name ?? "engine",
    ytdlp: reg.ytdlp ?? null,
    activeJobs: reg.activeJobs ?? 0,
    maxConcurrentJobs: reg.maxConcurrentJobs ?? null,
    capabilities: { mtproto: reg.capabilities?.mtproto ?? false, localBotApi: reg.capabilities?.localBotApi ?? false },
    lastSeen: now,
  };
  await setAppConfig(db, ENGINE_KEY, JSON.stringify(record), null, now);
  return "registered";
}

export async function loadEngine(db: D1Database): Promise<EngineRecord | null> {
  const raw = (await getAppConfig(db))[ENGINE_KEY];
  if (!raw) return null;
  try {
    return JSON.parse(raw) as EngineRecord;
  } catch {
    return null;
  }
}

export class HttpBackend implements MediaBackend {
  constructor(
    private readonly apiKey: string,
    private readonly db: D1Database,
    private readonly now: () => number,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  private async engine(): Promise<EngineRecord> {
    const engine = await loadEngine(this.db);
    if (!engine) throw new BackendUnavailable("the media engine is not registered (is it running?)");
    if (this.now() - engine.lastSeen > ENGINE_FRESH_SECONDS) throw new BackendUnavailable(`the media engine was last seen ${this.now() - engine.lastSeen}s ago`);
    return engine;
  }

  async available(): Promise<boolean> {
    try {
      await this.engine();
      return true;
    } catch {
      return false;
    }
  }

  private async send(path: string, init: { method?: string; body?: unknown } = {}, timeoutMs = 30_000): Promise<Response> {
    const engine = await this.engine();
    const headers = new Headers({ authorization: `Bearer ${this.apiKey}` });
    let body: string | undefined;
    if (init.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.body);
    }
    try {
      return await this.fetchImpl(`${engine.url}${path}`, { method: init.method ?? (body ? "POST" : "GET"), headers, ...(body ? { body } : {}), signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new BackendUnavailable(error instanceof Error ? error.message : String(error));
    }
  }

  private async json<T>(res: Response): Promise<T> {
    if (!res.ok) throw new BackendUnavailable(`engine returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }

  async inspect(_jobId: string, url: string, correlationId: string): Promise<InspectOutcome> {
    return this.json<InspectOutcome>(await this.send("/inspect", { body: { url, correlationId } }, 150_000));
  }

  async frames(_jobId: string, url: string, formatId: string, durationSeconds: number | null, count: number): Promise<FramesOutcome> {
    const body = await this.json<{ ok: boolean; data?: { frames: { timestamp: number; jpegBase64: string }[] }; error?: { code: never; message: string; retryable: boolean } }>(
      await this.send("/frames", { body: { url, formatId, durationSeconds, count } }, 170_000),
    );
    return body.ok && body.data ? { ok: true, frames: body.data.frames } : { ok: false, error: body.error ?? { code: "internal", message: "frames failed", retryable: false } };
  }

  async startJob(request: ContainerStartJobRequest): Promise<ContainerJobStatus> {
    const res = await this.send("/jobs", { body: request }, 60_000);
    if (res.status >= 400) throw new BackendUnavailable(`engine rejected the job: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as ContainerJobStatus;
  }

  async jobStatus(jobId: string): Promise<ContainerJobStatus | null> {
    try {
      const res = await this.send(`/jobs/${jobId}`, {}, 20_000);
      return res.ok ? ((await res.json()) as ContainerJobStatus) : null;
    } catch {
      return null;
    }
  }

  async cancel(jobId: string): Promise<void> {
    try {
      await this.send(`/jobs/${jobId}/cancel`, { method: "POST" }, 15_000);
    } catch {
      /* engine offline: the job is already cancelled in D1 and the engine drops it on its next restart */
    }
  }

  async release(jobId: string): Promise<void> {
    try {
      await this.send(`/jobs/${jobId}`, { method: "DELETE" }, 15_000);
    } catch {
      /* best effort: the engine also cleans its work directory itself */
    }
  }

  async diagnostics(): Promise<{ ok: boolean; detail: unknown }> {
    try {
      const engine = await this.engine();
      const res = await this.send("/diagnostics", {}, 30_000);
      return { ok: res.ok, detail: res.ok ? { ...((await res.json()) as object), engine: { name: engine.name, lastSeenSecondsAgo: this.now() - engine.lastSeen, capabilities: engine.capabilities } } : `HTTP ${res.status}` };
    } catch (error) {
      return { ok: false, detail: String(error instanceof Error ? error.message : error) };
    }
  }
}
