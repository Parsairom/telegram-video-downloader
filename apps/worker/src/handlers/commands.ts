import type { Deps } from "../app";
import { formatDate } from "../bot/format";
import type { Messages } from "../bot/i18n";
import type { TgMessage } from "../bot/telegram";
import { cancelJob } from "../services/jobs";
import { listActiveJobsForUser } from "../db/jobs";
import type { UserRow } from "../db/types";
import { setUserState } from "../db/users";
import { mainMenu } from "../keyboards";
import { handleAdminCommand } from "./admin";
import { showHistory } from "./history";
import { showSettings } from "./settings";

export async function handleCommand(deps: Deps, user: UserRow, m: Messages, msg: TgMessage, text: string): Promise<void> {
  const chatId = msg.chat.id;
  const [rawCmd = "", ...args] = text.trim().split(/\s+/);
  const cmd = rawCmd.split("@")[0]!.toLowerCase();

  switch (cmd) {
    case "/start":
      await setUserState(deps.db, user.tg_user_id, null, deps.now());
      await deps.tg.sendMessage(chatId, m.welcome(user.first_name), { reply_markup: mainMenu(m) });
      return;
    case "/help":
      await deps.tg.sendMessage(chatId, m.help, { reply_markup: mainMenu(m) });
      return;
    case "/privacy":
      await deps.tg.sendMessage(chatId, m.privacy);
      return;
    case "/download":
      await deps.tg.sendMessage(chatId, m.sendLink);
      return;
    case "/settings":
      await showSettings(deps, user, chatId);
      return;
    case "/history":
      await showHistory(deps, user, chatId, 0);
      return;
    case "/account":
      await showAccount(deps, user, m, chatId);
      return;
    case "/cancel":
      await cancelAll(deps, user, m, chatId);
      return;
    case "/admin":
      await handleAdminCommand(deps, user, chatId, args);
      return;
    default:
      await deps.tg.sendMessage(chatId, m.unknownInput);
  }
}

export async function cancelAll(deps: Deps, user: UserRow, m: Messages, chatId: number): Promise<void> {
  await setUserState(deps.db, user.tg_user_id, null, deps.now()); // also abandons any pending text prompt
  const active = await listActiveJobsForUser(deps.db, user.tg_user_id);
  let cancelled = 0;
  for (const job of active) if (await cancelJob(deps, job)) cancelled++;
  await deps.tg.sendMessage(chatId, cancelled ? m.cancelledCount(cancelled) : m.nothingToCancel);
}

export async function showAccount(deps: Deps, user: UserRow, m: Messages, chatId: number): Promise<void> {
  const startOfDay = deps.now() - (deps.now() % 86400);
  const [today, active] = await Promise.all([
    deps.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE user_id = ? AND created_at >= ? AND status != 'ready'").bind(user.tg_user_id, startOfDay).first<{ n: number }>(),
    listActiveJobsForUser(deps.db, user.tg_user_id),
  ]);
  await deps.tg.sendMessage(
    chatId,
    m.accountText({
      id: user.tg_user_id,
      username: user.username,
      total: user.total_jobs,
      active: active.length,
      today: today?.n ?? 0,
      limits: { perUser: deps.cfg.maxJobsPerUser, perMinute: deps.cfg.rateLimitPerMinute },
      since: formatDate(user.created_at),
    }),
  );
}
