import type { Deps } from "../app";
import { messages } from "../bot/i18n";
import { jobSelection } from "../db/jobs";
import { countJobsForUser, deleteUserHistory, listJobsForUser } from "../db/jobs";
import type { TgCallbackQuery } from "../bot/telegram";
import type { UserRow } from "../db/types";
import { confirmClearKeyboard, historyKeyboard } from "../keyboards";

export const HISTORY_PAGE_SIZE = 5;

export async function showHistory(deps: Deps, user: UserRow, chatId: number, page = 0, editMessageId?: number): Promise<void> {
  const m = messages(user.language);
  const total = await countJobsForUser(deps.db, user.tg_user_id);
  if (total === 0) {
    if (editMessageId) await deps.tg.editMessageText(chatId, editMessageId, m.historyEmpty);
    else await deps.tg.sendMessage(chatId, m.historyEmpty);
    return;
  }
  const pages = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));
  const p = Math.min(Math.max(page, 0), pages - 1);
  const jobs = await listJobsForUser(deps.db, user.tg_user_id, HISTORY_PAGE_SIZE, p * HISTORY_PAGE_SIZE);
  const lines = jobs.map((j, i) => m.historyLine(p * HISTORY_PAGE_SIZE + i + 1, j.site, jobSelection(j)?.label ?? null, m.statusIcons[j.status] ?? "•", j.title));
  const text = `${m.historyHeader(p + 1, pages, total)}\n\n${lines.join("\n")}`;
  const markup = historyKeyboard(m, jobs, p, pages);
  if (editMessageId) await deps.tg.editMessageText(chatId, editMessageId, text, markup);
  else await deps.tg.sendMessage(chatId, text, { reply_markup: markup });
}

export async function handleHistoryCallback(deps: Deps, cq: TgCallbackQuery, user: UserRow, sub: "page" | "clear" | "clear_yes", arg: string | null): Promise<void> {
  const m = messages(user.language);
  const chatId = cq.message?.chat.id ?? user.tg_user_id;
  const messageId = cq.message?.message_id;
  if (sub === "page") {
    await showHistory(deps, user, chatId, Number(arg ?? 0), messageId);
    return void (await deps.tg.answerCallbackQuery(cq.id));
  }
  if (sub === "clear") {
    if (messageId) await deps.tg.editMessageText(chatId, messageId, m.confirmClear, confirmClearKeyboard(m));
    return void (await deps.tg.answerCallbackQuery(cq.id));
  }
  const removed = await deleteUserHistory(deps.db, user.tg_user_id);
  if (messageId) await deps.tg.editMessageText(chatId, messageId, m.historyCleared(removed));
  await deps.tg.answerCallbackQuery(cq.id);
}
