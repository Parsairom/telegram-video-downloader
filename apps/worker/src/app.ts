import type { QueueMessage } from "@tvd/shared-types";
import { Telegram } from "./bot/telegram";
import type { Config } from "./config";
import { isRuntimeKey, parseConfig, RUNTIME_KEYS } from "./config";
import { getAppConfig } from "./db/misc";
import { createLogger, type Logger } from "./log";
import { resolvesToPublicAddresses } from "./security/url";
import { MediaClient, type MediaBackend } from "./services/container";
import { HttpBackend } from "./services/engine";

export interface JobQueue {
  send(message: QueueMessage, options?: { delaySeconds?: number }): Promise<void>;
}

/** Everything a request handler needs. Production wiring is in createDeps(); tests pass fakes. */
export interface Deps {
  env: Env;
  cfg: Config;
  log: Logger;
  db: D1Database;
  /** null on the free plan (R2 not enabled): link delivery and R2 cleanup are then disabled */
  bucket: R2Bucket | null;
  tg: Telegram;
  backend: MediaBackend;
  queue: JobQueue;
  /** Defence-in-depth DNS check for submitted hostnames (DNS-over-HTTPS). The container enforces the same policy on every connection. */
  dnsCheck(host: string): Promise<{ ok: boolean; reason?: string; resolved: boolean }>;
  now(): number;
  waitUntil(promise: Promise<unknown>): void;
}

const CONFIG_TTL_MS = 15_000;
let cached: { at: number; env: Env; cfg: Config } | null = null;

/** Environment config merged with administrator overrides stored in D1 (cached briefly per isolate). */
export async function loadConfig(env: Env, db: D1Database): Promise<Config> {
  if (cached && cached.env === env && Date.now() - cached.at < CONFIG_TTL_MS) return structuredClone(cached.cfg);
  const cfg = parseConfig(env as unknown as Record<string, unknown>);
  try {
    const overrides = await getAppConfig(db);
    cfg.maintenance = overrides.maintenance === "1";
    for (const [key, value] of Object.entries(overrides)) {
      if (isRuntimeKey(key)) {
        const n = Number(value);
        if (Number.isInteger(n)) RUNTIME_KEYS[key].apply(cfg, n);
      }
    }
  } catch {
    /* D1 hiccup: run with the deployed defaults rather than fail the request */
  }
  cached = { at: Date.now(), env, cfg };
  return cfg;
}

export function invalidateConfigCache(): void {
  cached = null;
}

export async function createDeps(env: Env, ctx: { waitUntil(p: Promise<unknown>): void }, overrides: Partial<Deps> = {}): Promise<Deps> {
  const cfg = overrides.cfg ?? (await loadConfig(env, env.DB));
  return {
    env,
    cfg,
    log: createLogger(cfg.logLevel),
    db: env.DB,
    bucket: (env as { MEDIA_BUCKET?: R2Bucket }).MEDIA_BUCKET ?? null,
    tg: new Telegram(env.BOT_TOKEN),
    backend: cfg.mediaBackend === "http" ? new HttpBackend(env.CONTAINER_API_KEY, env.DB, () => Math.floor(Date.now() / 1000)) : new MediaClient(env, cfg),
    queue: {
      send: async (message, options) => {
        await env.JOBS_QUEUE.send(message, options?.delaySeconds ? { delaySeconds: options.delaySeconds } : undefined);
      },
    },
    dnsCheck: (host) => resolvesToPublicAddresses(host),
    now: () => Math.floor(Date.now() / 1000),
    waitUntil: (p) => ctx.waitUntil(p),
    ...overrides,
  };
}
