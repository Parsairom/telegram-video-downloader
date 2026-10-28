/** Administrator commands and panel. Only Telegram IDs in ADMIN_USER_IDS may use them; nothing is exposed over HTTP. */
import { ACTIVE_STATUSES } from "@tvd/shared-types";
import type { Deps } from "../app";
import { invalidateConfigCache } from "../app";
import { escapeHtml as e, formatBytes, formatDate } from "../bot/format";
import { messages } from "../bot/i18n";
import type { TgCallbackQuery } from "../bot/telegram";
import { isRuntimeKey, RUNTIME_KEYS, validateRuntimeValue } from "../config";
import { countsByStatus, listJobsByStatus, oldestAge } from "../db/jobs";
import { deleteAppConfig, getAppConfig, readStats, setAppConfig } from "../db/misc";
import type { UserRow } from "../db/types";
import { blockUser, countUsers, listBlockedUsers, unblockUser } from "../db/users";
import { adminKeyboard, announceConfirmKeyboard } from "../keyboards";
import { startBroadcast } from "../services/broadcast";
import { runCleanup } from "../services/cleanup";

export function isAdmin(deps: Deps, userId: number): boolean {
  return deps.cfg.adminIds.has(userId);
}

const pre = (text: string) => `<pre>${e(text)}</pre>`;

export async function handleAdminCommand(deps: Deps, user: UserRow, chatId: number, args: string[]): Promise<void> {
  const m = messages(user.language);
  if (!isAdmin(deps, user.tg_user_id)) return void (await deps.tg.sendMessage(chatId, m.adminOnly));
  const [sub = "", ...rest] = args;
  const send = (text: string, markup?: ReturnType<typeof adminKeyboard>) => deps.tg.sendMessage(chatId, text, markup ? { reply_markup: markup } : {});

  switch (sub.toLowerCase()) {
    case "":
    case "help":
      return void (await send(m.adminHelp, adminKeyboard()));
    case "stats":
      return void (await send(await statsText(deps)));
    case "active":
      return void (await send(await jobsText(deps, ACTIVE_STATUSES, "active jobs")));
    case "failed":
      return void (await send(await jobsText(deps, ["failed"], "recent failed jobs")));
    case "health":
      return void (await send(await healthText(deps)));
    case "limits":
      return void (await send(await limitsText(deps)));
    case "set": {
      const [key, value] = rest;
      if (!key || !isRuntimeKey(key)) return void (await send(`unknown key. valid: ${Object.keys(RUNTIME_KEYS).join(", ")}`));
      const n = Number(value);
      const problem = validateRuntimeValue(key, n);
      if (problem) return void (await send(e(problem)));
      await setAppConfig(deps.db, key, String(n), user.tg_user_id, deps.now());
      invalidateConfigCache();
      return void (await send(`✅ ${e(key)} = ${n}`));
    }
    case "reset": {
      const [key] = rest;
      if (!key || !isRuntimeKey(key)) return void (await send("unknown key"));
      await deleteAppConfig(deps.db, key);
      invalidateConfigCache();
      return void (await send(`✅ ${e(key)} reset to the deployed default`));
    }
    case "block": {
      const id = Number(rest[0]);
      if (!Number.isInteger(id) || id <= 0) return void (await send("usage: /admin block &lt;user_id&gt; [reason]"));
      if (deps.cfg.adminIds.has(id)) return void (await send("refusing to block an administrator"));
      await blockUser(deps.db, id, rest.slice(1).join(" ") || null);
      return void (await send(`⛔ user ${id} blocked`));
    }
    case "unblock": {
      const id = Number(rest[0]);
      if (!Number.isInteger(id)) return void (await send("usage: /admin unblock &lt;user_id&gt;"));
      await unblockUser(deps.db, id);
      return void (await send(`✅ user ${id} unblocked`));
    }
    case "blocked": {
      const rows = await listBlockedUsers(deps.db);
      return void (await send(rows.length ? rows.map((r) => `${r.tg_user_id}${r.username ? ` @${e(r.username)}` : ""}${r.block_reason ? ` — ${e(r.block_reason)}` : ""}`).join("\n") : "no blocked users"));
    }
    case "cleanup": {
      const report = await runCleanup(deps);
      return void (await send(pre(JSON.stringify(report, null, 2))));
    }
    case "maintenance": {
      const on = rest[0]?.toLowerCase();
      if (on !== "on" && on !== "off") return void (await send("usage: /admin maintenance on|off"));
      if (on === "on") await setAppConfig(deps.db, "maintenance", "1", user.tg_user_id, deps.now());
      else await deleteAppConfig(deps.db, "maintenance");
      return void (await send(`🛠 maintenance mode ${on}`));
    }
    case "announce": {
      const text = rest.join(" ").trim();
      if (!text) return void (await send("usage: /admin announce &lt;text&gt;"));
      if (text.length > 3500) return void (await send("announcement too long"));
      const token = crypto.randomUUID().slice(0, 8).replace(/-/g, "");
      await setAppConfig(deps.db, `announce_pending:${token}`, JSON.stringify({ text, adminId: user.tg_user_id }), user.tg_user_id, deps.now());
      const total = await countUsers(deps.db);
      return void (await send(`📣 Preview (will be sent to up to ${total} users):\n\n${e(text)}`, announceConfirmKeyboard(token)));
    }
    default:
      return void (await send(m.adminHelp, adminKeyboard()));
  }
}

export async function handleAdminCallback(deps: Deps, cq: TgCallbackQuery, user: UserRow, sub: string, arg: string | null): Promise<void> {
  const chatId = cq.message?.chat.id ?? user.tg_user_id;
  if (!isAdmin(deps, user.tg_user_id)) return void (await deps.tg.answerCallbackQuery(cq.id, messages(user.language).adminOnly, true));
  await deps.tg.answerCallbackQuery(cq.id);
  if (sub === "annyes" || sub === "anncancel") {
    const key = `announce_pending:${arg}`;
    const pending = (await getAppConfig(deps.db))[key];
    await deleteAppConfig(deps.db, key);
    if (sub === "anncancel" || !pending) return void (await deps.tg.sendMessage(chatId, "announcement cancelled"));
    const { text } = JSON.parse(pending) as { text: string };
    await startBroadcast(deps, user.tg_user_id, text);
    return void (await deps.tg.sendMessage(chatId, "📣 announcement started (sent in batches every minute)"));
  }
  await handleAdminCommand(deps, user, chatId, [sub]);
}

// ───────────────────────── renderers ─────────────────────────

async function statsText(deps: Deps): Promise<string> {
  const [counts, users, today, week] = await Promise.all([countsByStatus(deps.db), countUsers(deps.db), readStats(deps.db, 0, deps.now()), readStats(deps.db, 6, deps.now())]);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const completed = counts.completed ?? 0;
  const failed = counts.failed ?? 0;
  const rate = completed + failed ? `${Math.round((completed / (completed + failed)) * 100)}%` : "n/a";
  const failures = Object.entries(week).filter(([k]) => k.startsWith("fail_")).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${k.slice(5)}: ${v}`).join("\n") || "  none";
  return pre(
    [
      `users: ${users}`,
      `jobs (all time): ${total}  success rate: ${rate}`,
      `by status: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ")}`,
      `today: urls=${today.urls_submitted ?? 0} started=${today.downloads_started ?? 0} done=${today.completed ?? 0} cancelled=${today.cancelled ?? 0}`,
      `7d delivered: ${formatBytes(week.bytes_delivered ?? 0)} (bot api ${week.delivery_bot_api_cloud ?? 0}, mtproto ${week.delivery_mtproto ?? 0}, local ${week.delivery_bot_api_local ?? 0}, link ${week.delivery_r2_link ?? 0})`,
      `7d failures by category:\n${failures}`,
    ].join("\n"),
  );
}

async function jobsText(deps: Deps, statuses: readonly string[], title: string): Promise<string> {
  const jobs = await listJobsByStatus(deps.db, statuses as never, 15);
  if (jobs.length === 0) return `${title}: none`;
  return pre(
    `${title}\n` +
      jobs.map((j) => `${j.id.slice(4, 12)} u${j.user_id} ${j.status} ${j.site ?? "-"} try ${j.attempts}/${j.max_attempts} ${j.error_code ?? ""} ${formatDate(j.updated_at)}`).join("\n"),
  );
}

async function healthText(deps: Deps): Promise<string> {
  const now = deps.now();
  const lines: string[] = [];
  try {
    await deps.db.prepare("SELECT 1").first();
    lines.push("D1: ok");
  } catch (error) {
    lines.push(`D1: ERROR ${String(error)}`);
  }
  if (deps.bucket) {
    try {
      await deps.bucket.list({ limit: 1 });
      lines.push("R2: ok");
    } catch (error) {
      lines.push(`R2: ERROR ${String(error)}`);
    }
  } else {
    lines.push("R2: not configured (download-link delivery is disabled)");
  }
  const [queued, retry, running] = await Promise.all([oldestAge(deps.db, "queued", now), oldestAge(deps.db, "retry_wait", now), countsByStatus(deps.db)]);
  lines.push(`queue: queued=${running.queued ?? 0} (oldest ${queued ?? 0}s) retry_wait=${running.retry_wait ?? 0} (oldest ${retry ?? 0}s) running=${(running.downloading ?? 0) + (running.processing ?? 0) + (running.uploading ?? 0)}/${deps.cfg.maxConcurrentJobs}`);
  try {
    const wh = await deps.tg.getWebhookInfo();
    lines.push(`webhook: ${wh.url ? "set" : "NOT SET"} pending=${wh.pending_update_count}${wh.last_error_message ? ` lastError="${wh.last_error_message}"` : ""}`);
  } catch (error) {
    lines.push(`webhook: ERROR ${String(error)}`);
  }
  const diag = await deps.backend.diagnostics();
  lines.push(`container: ${diag.ok ? "ok" : "ERROR"} ${typeof diag.detail === "string" ? diag.detail : JSON.stringify(diag.detail)}`);
  return pre(lines.join("\n"));
}

async function limitsText(deps: Deps): Promise<string> {
  const c = deps.cfg;
  const overrides = await getAppConfig(deps.db);
  const shown = Object.keys(RUNTIME_KEYS).filter((k) => overrides[k] !== undefined).map((k) => `${k}=${overrides[k]}`);
  return pre(
    [
      `max_output: ${formatBytes(c.maxOutputBytes)}  cloud limit: ${formatBytes(c.cloudUploadLimitBytes)}  mtproto: ${c.mtprotoEnabled ? formatBytes(c.mtprotoUploadLimitBytes) : "disabled"}  local limit: ${c.localBotApiEnabled ? formatBytes(c.localUploadLimitBytes) : "disabled"}  links: ${c.linkDeliveryEnabled ? "on" : "off"}`,
      `media backend: ${c.mediaBackend}`,
      `max_concurrent_jobs=${c.maxConcurrentJobs} max_jobs_per_user=${c.maxJobsPerUser} max_queued_jobs=${c.maxQueuedJobs}`,
      `max_duration_seconds=${c.maxDurationSeconds} max_retries=${c.maxRetries} rate_limit_per_minute=${c.rateLimitPerMinute}`,
      `timeouts: download=${c.downloadTimeoutSeconds}s processing=${c.processingTimeoutSeconds}s upload=${c.uploadTimeoutSeconds}s`,
      `retention: files=${c.fileRetentionHours}h history=${c.historyRetentionDays}d  delivery policy=${c.deliveryPolicy}`,
      `runtime overrides: ${shown.join(" ") || "none"}`,
      `maintenance: ${overrides.maintenance ? "ON" : "off"}`,
    ].join("\n"),
  );
}
