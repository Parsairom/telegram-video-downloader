import { createDeps } from "./app";
import { handleUpdate } from "./bot/router";
import type { TgUpdate } from "./bot/telegram";
import { claimUpdate } from "./db/misc";
import { MediaInspector, MediaJob } from "./durable/containers";
import { handleDownload, handleInternal } from "./internal/routes";
import { handleQueue } from "./queue/consumer";
import { verifyWebhookSecret } from "./security/webhook";
import { runSweeper } from "./services/sweeper";

export { MediaInspector, MediaJob };

const MAX_UPDATE_BYTES = 1_000_000;

const text = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

async function telegramWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "POST") return text("method not allowed", 405);
  if (!verifyWebhookSecret(request, env.TELEGRAM_WEBHOOK_SECRET)) return text("unauthorized", 401);
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_UPDATE_BYTES) return text("payload too large", 413);

  let update: TgUpdate;
  try {
    update = (await request.json()) as TgUpdate;
  } catch {
    return text("bad request", 400);
  }
  if (typeof update?.update_id !== "number") return text("bad request", 400);

  const deps = await createDeps(env, ctx);
  // Telegram redelivers on timeouts; the claim makes handling idempotent. If D1 itself fails here we return 500
  // (nothing was done yet, so Telegram's retry is safe).
  if (!(await claimUpdate(deps.db, update.update_id, deps.now()))) return text("duplicate");
  try {
    await handleUpdate(deps, update);
  } catch (error) {
    // The update is already claimed: answering 500 would make Telegram redeliver and could duplicate messages.
    deps.log.error("update handler failed", { updateId: update.update_id, error });
    const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
    if (chatId) ctx.waitUntil(deps.tg.sendMessage(chatId, "⚠️ خطای داخلی رخ داد. لطفاً دوباره امتحان کن.").then(() => undefined, () => undefined));
  }
  return text("ok");
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/telegram/webhook") return await telegramWebhook(request, env, ctx);
      if (url.pathname === "/health") {
        // minimal on purpose: no versions, counts or configuration are disclosed to the internet
        await env.DB.prepare("SELECT 1").first();
        return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
      }
      if (url.pathname.startsWith("/internal/") || url.pathname.startsWith("/d/")) {
        const deps = await createDeps(env, ctx);
        const response = url.pathname.startsWith("/d/") ? await handleDownload(request, deps, url) : await handleInternal(request, deps, url);
        if (response) return response;
      }
      if (url.pathname === "/") return text("Telegram video downloader");
      return text("not found", 404);
    } catch (error) {
      console.error(JSON.stringify({ level: "error", msg: "unhandled request error", path: url.pathname, error: String(error) }));
      return text("internal error", 500);
    }
  },

  async queue(batch, env, ctx): Promise<void> {
    await handleQueue(batch, env, ctx);
  },

  async scheduled(_event, env, ctx): Promise<void> {
    const deps = await createDeps(env, ctx);
    ctx.waitUntil(
      runSweeper(deps).then(
        (report) => deps.log.info("sweep complete", { ...report }),
        (error) => deps.log.error("sweep failed", { error }),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
