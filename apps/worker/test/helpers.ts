import type { ContainerJobStatus, ContainerStartJobRequest, InspectResult, MediaFormat } from "@tvd/shared-types";
import { env } from "cloudflare:workers";
import type { Deps, JobQueue } from "../src/app";
import { Telegram, type TgCallbackQuery, type TgMessage, type TgUpdate } from "../src/bot/telegram";
import { parseConfig, type Config } from "../src/config";
import { createLogger } from "../src/log";
import type { FramesOutcome, InspectOutcome, MediaBackend } from "../src/services/container";
import { BackendUnavailable } from "../src/services/container";
import { handleUpdate } from "../src/bot/router";
import { processMessage } from "../src/queue/consumer";
import type { QueueMessage } from "@tvd/shared-types";

// ───────────────────────── fake Telegram ─────────────────────────

export interface TgCall {
  method: string;
  params: Record<string, any>;
}

export function fakeTelegram() {
  const calls: TgCall[] = [];
  let nextId = 5000;
  const failures: { method: string; status: number; description: string; times: number }[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = url.split("/").pop()!;
    let params: Record<string, any> = {};
    if (typeof init?.body === "string") params = JSON.parse(init.body);
    else if (init?.body instanceof FormData) params = Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : "[file]"]));
    calls.push({ method, params });
    const failure = failures.find((f) => f.method === method && f.times > 0);
    if (failure) {
      failure.times--;
      return new Response(JSON.stringify({ ok: false, error_code: failure.status, description: failure.description }), { status: failure.status });
    }
    const sendLike = ["sendMessage", "sendPhoto", "editMessageText", "editMessageCaption"].includes(method);
    const result = sendLike ? { message_id: method.startsWith("edit") ? params.message_id : ++nextId, chat: { id: params.chat_id } } : method === "sendMediaGroup" ? [{ message_id: ++nextId }] : true;
    return new Response(JSON.stringify({ ok: true, result }));
  };
  return {
    tg: new Telegram("123456:FAKE-TOKEN", fetchImpl as typeof fetch),
    calls,
    failNext: (method: string, status: number, description: string, times = 1) => failures.push({ method, status, description, times }),
    of: (method: string) => calls.filter((c) => c.method === method),
    last: (method: string) => calls.filter((c) => c.method === method).at(-1),
    texts: () => calls.filter((c) => ["sendMessage", "editMessageText", "editMessageCaption", "sendPhoto"].includes(c.method)).map((c) => String(c.params.text ?? c.params.caption ?? "")),
    reset: () => void (calls.length = 0),
  };
}

// ───────────────────────── fake media backend ─────────────────────────

export class FakeBackend implements MediaBackend {
  inspectOutcome: InspectOutcome | (() => InspectOutcome) = { ok: true, data: { kind: "video", info: sampleInfo() } };
  inspectCalls: string[] = [];
  started: ContainerStartJobRequest[] = [];
  statuses = new Map<string, ContainerJobStatus | null>();
  startError: Error | null = null;
  cancelled: string[] = [];
  released: string[] = [];
  framesOutcome: FramesOutcome = { ok: true, frames: [{ timestamp: 10, jpegBase64: btoa("jpeg1") }, { timestamp: 20, jpegBase64: btoa("jpeg2") }] };

  async inspect(_jobId: string, url: string): Promise<InspectOutcome> {
    this.inspectCalls.push(url);
    const outcome = typeof this.inspectOutcome === "function" ? this.inspectOutcome() : this.inspectOutcome;
    if (!outcome.ok && outcome.error.code === "container_lost") throw new BackendUnavailable(outcome.error.message);
    return outcome;
  }
  async frames(): Promise<FramesOutcome> {
    return this.framesOutcome;
  }
  async startJob(request: ContainerStartJobRequest): Promise<ContainerJobStatus> {
    if (this.startError) throw this.startError;
    this.started.push(request);
    return { jobId: request.jobId, state: "running", phase: null, progress: null, result: null, errorCode: null, message: null };
  }
  async jobStatus(jobId: string): Promise<ContainerJobStatus | null> {
    return this.statuses.has(jobId) ? (this.statuses.get(jobId) ?? null) : null;
  }
  async cancel(jobId: string) {
    this.cancelled.push(jobId);
  }
  async release(jobId: string) {
    this.released.push(jobId);
  }
  async diagnostics() {
    return { ok: true, detail: { ytdlp: "test", diskFreeBytes: 10 ** 10, activeJobs: 0 } };
  }
}

// ───────────────────────── sample media ─────────────────────────

export function fmt(partial: Partial<MediaFormat> & { formatId: string; kind: "video" | "audio" }): MediaFormat {
  return {
    ext: "mp4", hasAudio: false, width: null, height: null, fps: null, vcodec: null, acodec: null, dynamicRange: null,
    audioLanguage: null, audioChannels: null, tbr: null, filesize: null, filesizeApprox: false, protocol: "https", note: null,
    ...partial,
  };
}

export function sampleInfo(overrides: Partial<InspectResult> = {}): InspectResult {
  return {
    extractor: "Youtube", site: "YouTube", originalUrl: "https://www.youtube.com/watch?v=abc", webpageUrl: "https://www.youtube.com/watch?v=abc",
    title: "Big Buck Bunny", description: "A bunny.", thumbnail: "https://img.example.test/t.jpg", durationSeconds: 600,
    uploader: "Blender", uploadDate: "20141110", isLive: false,
    formats: [
      fmt({ formatId: "140", kind: "audio", ext: "m4a", acodec: "mp4a.40.2", audioChannels: 2, tbr: 129, filesize: 10_000_000, audioLanguage: "en", note: "English (default)" }),
      fmt({ formatId: "258", kind: "audio", ext: "m4a", acodec: "mp4a.40.2", audioChannels: 6, tbr: 388, filesize: 29_000_000, audioLanguage: "en" }),
      fmt({ formatId: "160", kind: "video", width: 256, height: 144, fps: 30, vcodec: "avc1.4D400C", filesize: 5_000_000 }),
      fmt({ formatId: "134", kind: "video", width: 640, height: 360, fps: 30, vcodec: "avc1.4D401E", filesize: 20_000_000 }),
      fmt({ formatId: "18", kind: "video", hasAudio: true, width: 640, height: 360, fps: 30, vcodec: "avc1.42001E", acodec: "mp4a.40.2", filesize: 30_000_000 }),
      fmt({ formatId: "298", kind: "video", width: 1280, height: 720, fps: 60, vcodec: "avc1.4D4020", filesize: 80_000_000 }),
      fmt({ formatId: "299", kind: "video", width: 1920, height: 1080, fps: 60, vcodec: "avc1.64002A", filesize: 300_000_000 }),
      fmt({ formatId: "303", kind: "video", ext: "webm", width: 1920, height: 1080, fps: 60, vcodec: "vp9", filesize: 200_000_000 }),
      fmt({ formatId: "399", kind: "video", width: 1920, height: 1080, fps: 60, vcodec: "av01.0.09M.08", filesize: 150_000_000 }),
      fmt({ formatId: "315", kind: "video", ext: "webm", width: 3840, height: 2160, fps: 60, vcodec: "vp9", filesize: 2_400_000_000, dynamicRange: "HDR10" }),
    ],
    ...overrides,
  };
}

// ───────────────────────── wiring ─────────────────────────

export function testConfig(overrides: Record<string, unknown> = {}): Config {
  return parseConfig({ ...(env as unknown as Record<string, unknown>), ...overrides });
}

export interface QueuedMessage {
  body: QueueMessage;
  delaySeconds?: number;
  /** epoch seconds on the harness clock before which the message is not delivered */
  availableAt: number;
}

export interface Harness {
  deps: Deps;
  tg: ReturnType<typeof fakeTelegram>;
  backend: FakeBackend;
  queue: { messages: QueuedMessage[] } & JobQueue;
  clock: { now: number };
  waiting: Promise<unknown>[];
  drain(): Promise<void>;
  /** Move the clock forward (delayed queue messages become deliverable). */
  advance(seconds: number): void;
  /** Deliver every message that is due, as the Queue consumer would (delays are honoured). Returns how many ran. */
  runQueue(max?: number): Promise<number>;
}

export function makeHarness(configOverrides: Record<string, unknown> = {}): Harness {
  const tg = fakeTelegram();
  const backend = new FakeBackend();
  const clock = { now: 1_760_000_000 };
  const messages: QueuedMessage[] = [];
  const waiting: Promise<unknown>[] = [];
  const queue = {
    messages,
    send: async (body: QueueMessage, options?: { delaySeconds?: number }) =>
      void messages.push({ body, availableAt: clock.now + (options?.delaySeconds ?? 0), ...(options?.delaySeconds ? { delaySeconds: options.delaySeconds } : {}) }),
  };
  const deps: Deps = {
    env,
    cfg: testConfig(configOverrides),
    log: createLogger("error"),
    db: env.DB,
    bucket: env.MEDIA_BUCKET,
    tg: tg.tg,
    backend,
    queue,
    // no network in tests; the DoH logic itself is unit-tested in unit-security.test.ts
    dnsCheck: async () => ({ ok: true, resolved: false }),
    now: () => clock.now,
    waitUntil: (p) => void waiting.push(p.catch(() => undefined)),
  };
  const harness: Harness = {
    deps, tg, backend, queue, clock, waiting,
    async drain() {
      while (waiting.length) await Promise.all(waiting.splice(0));
    },
    advance(seconds: number) {
      clock.now += seconds;
    },
    async runQueue(max = 20) {
      let processed = 0;
      for (;;) {
        const index = messages.findIndex((m) => m.availableAt <= clock.now);
        if (index === -1 || processed >= max) break;
        const [message] = messages.splice(index, 1);
        const result = await processMessage(deps, message!.body, 1);
        if (!result.done) messages.push({ body: message!.body, availableAt: clock.now + (result.retryDelaySeconds ?? 30), delaySeconds: result.retryDelaySeconds ?? 30 });
        processed++;
        await harness.drain();
      }
      return processed;
    },
  };
  return harness;
}

// ───────────────────────── update builders ─────────────────────────

let updateCounter = 100;
let messageCounter = 1;

export function userMessage(userId: number, text: string, extra: Partial<TgMessage> = {}): TgUpdate {
  return {
    update_id: ++updateCounter,
    message: { message_id: ++messageCounter, chat: { id: userId, type: "private" }, from: { id: userId, first_name: `User${userId}`, username: `user${userId}` }, text, ...extra },
  };
}

export function callback(userId: number, data: string, messageId = 777): TgUpdate {
  const cq: TgCallbackQuery = {
    id: `cq${++updateCounter}`,
    from: { id: userId, first_name: `User${userId}` },
    message: { message_id: messageId, chat: { id: userId, type: "private" } },
    data,
  };
  return { update_id: ++updateCounter, callback_query: cq };
}

export async function send(h: Harness, update: TgUpdate): Promise<void> {
  await handleUpdate(h.deps, update);
  await h.drain();
}

/** The callback_data of the first button whose text contains `needle` in the last message/caption that had a keyboard. */
export function buttonData(h: Harness, needle: string | RegExp, method?: string): string {
  const calls = [...h.tg.calls].reverse().filter((c) => (method ? c.method === method : true) && c.params.reply_markup?.inline_keyboard);
  for (const call of calls) {
    for (const row of call.params.reply_markup.inline_keyboard as { text: string; callback_data?: string }[][]) {
      for (const button of row) {
        const hit = typeof needle === "string" ? button.text.includes(needle) : needle.test(button.text);
        if (hit && button.callback_data) return button.callback_data;
      }
    }
  }
  throw new Error(`no button matching ${needle}`);
}

export function allButtons(h: Harness): { text: string; callback_data?: string }[] {
  const call = [...h.tg.calls].reverse().find((c) => c.params.reply_markup?.inline_keyboard);
  return (call?.params.reply_markup.inline_keyboard as { text: string; callback_data?: string }[][] | undefined)?.flat() ?? [];
}
