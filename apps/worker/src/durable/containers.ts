/**
 * Container Durable Objects.
 *
 *   MediaJob       one instance per download job (named by job id): isolated disk, receives the bot token.
 *   MediaInspector small pool shared by all users for inspect / frame previews: never receives the bot token.
 *
 * Both run apps/media-container (same image). A container is only reachable through its Durable Object, and
 * every request is additionally authenticated with CONTAINER_API_KEY.
 */
import { Container } from "@cloudflare/containers";
import type { DurableObject } from "cloudflare:workers";

function compact(vars: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(vars).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== ""));
}

export class MediaJob extends Container<Env> {
  override defaultPort = 8080;
  override enableInternet = true;
  // Jobs run in the background inside the container; the Worker's per-minute sweeper polls each running job,
  // which counts as activity and keeps the instance awake. If the sweeper stops, the instance sleeps after this.
  override sleepAfter = "40m";

  constructor(ctx: DurableObject["ctx"], env: Env) {
    super(ctx, env);
    this.envVars = compact({
      CONTAINER_API_KEY: env.CONTAINER_API_KEY,
      BOT_TOKEN: env.BOT_TOKEN,
      LOCAL_BOT_TOKEN: env.LOCAL_BOT_TOKEN,
      TELEGRAM_API_ID: env.TELEGRAM_API_ID,
      TELEGRAM_API_HASH: env.TELEGRAM_API_HASH,
      LOCAL_BOT_API_ENABLED: env.LOCAL_BOT_API_ENABLED,
      WORK_DIR: env.TEMP_DIRECTORY,
      LOG_LEVEL: env.LOG_LEVEL,
      MAX_CONCURRENT_JOBS: "1",
    });
  }

  /** Called by the Worker (RPC) when a job is finished or cancelled so the instance stops billing immediately. */
  async shutdown(): Promise<void> {
    try {
      await this.destroy();
    } catch (error) {
      console.warn(JSON.stringify({ level: "warn", msg: "container shutdown failed", error: String(error) }));
    }
  }
}

export class MediaInspector extends Container<Env> {
  override defaultPort = 8080;
  override enableInternet = true;
  override sleepAfter = "10m";

  constructor(ctx: DurableObject["ctx"], env: Env) {
    super(ctx, env);
    this.envVars = compact({
      CONTAINER_API_KEY: env.CONTAINER_API_KEY,
      WORK_DIR: env.TEMP_DIRECTORY,
      LOG_LEVEL: env.LOG_LEVEL,
      MAX_CONCURRENT_JOBS: "1",
    });
  }
}
