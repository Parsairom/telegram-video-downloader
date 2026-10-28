/** Dispatches Telegram updates (messages and button presses) to handlers. */
import { handleJobAction } from "../callbacks/job-actions";
import { parseCallback } from "../callbacks/codec";
import type { Deps } from "../app";
import { handleAdminCallback, isAdmin } from "../handlers/admin";
import { handleCommand, showAccount } from "../handlers/commands";
import { showHistory, handleHistoryCallback } from "../handlers/history";
import { showSettings, handleSettingCallback } from "../handlers/settings";
import { handleStateInput } from "../handlers/text-input";
import { rateLimit } from "../db/misc";
import { readUserState, setUserState, upsertUser } from "../db/users";
import { mainMenu } from "../keyboards";
import { extractUrls } from "../security/url";
import { handleUrls } from "../services/jobs";
import { messages } from "./i18n";
import type { TgCallbackQuery, TgMessage, TgUpdate } from "./telegram";

export async function handleUpdate(deps: Deps, update: TgUpdate): Promise<void> {
  if (update.message) return handleMessage(deps, update.message);
  if (update.callback_query) return handleCallback(deps, update.callback_query);
}

async function handleMessage(deps: Deps, msg: TgMessage): Promise<void> {
  const from = msg.from;
  if (!from) return;
  if (msg.chat.type && msg.chat.type !== "private") return; // the bot only works in private chats
  const now = deps.now();
  const user = await upsertUser(deps.db, from, now);
  const m = messages(user.language);
  const chatId = msg.chat.id;

  if (user.is_blocked) {
    await deps.tg.sendMessage(chatId, m.blocked(user.block_reason));
    return;
  }
  if (deps.cfg.maintenance && !isAdmin(deps, user.tg_user_id)) {
    await deps.tg.sendMessage(chatId, m.maintenance);
    return;
  }
  const flood = await rateLimit(deps.db, `msg:${user.tg_user_id}`, 30, 60, now);
  if (!flood.allowed) {
    if (flood.count === flood.limit + 1) await deps.tg.sendMessage(chatId, m.rateLimited(flood.retryAfterSeconds));
    return;
  }

  const text = (msg.text ?? msg.caption ?? "").trim();
  if (text.startsWith("/")) return handleCommand(deps, user, m, msg, text);

  const labels = Object.entries(m.labels).find(([, label]) => label === text)?.[0];
  const pending = readUserState(user, now);
  if (pending && !labels) return handleStateInput(deps, user, m, msg, pending);
  if (pending && labels) await setUserState(deps.db, user.tg_user_id, null, now);

  switch (labels) {
    case "download":
      return void (await deps.tg.sendMessage(chatId, m.sendLink));
    case "settings":
      return showSettings(deps, user, chatId);
    case "history":
      return showHistory(deps, user, chatId, 0);
    case "help":
      return void (await deps.tg.sendMessage(chatId, m.help));
    case "account":
      return showAccount(deps, user, m, chatId);
  }

  const entityUrls = [...(msg.entities ?? []), ...(msg.caption_entities ?? [])].filter((e) => e.type === "text_link" && e.url).map((e) => e.url as string);
  const urls = extractUrls(text, entityUrls);
  if (urls.length > 0) return handleUrls(deps, user, m, msg, urls);

  await deps.tg.sendMessage(chatId, m.unknownInput, { reply_markup: mainMenu(m) });
}

async function handleCallback(deps: Deps, cq: TgCallbackQuery): Promise<void> {
  const parsed = parseCallback(cq.data);
  if (parsed.kind === "noop") return void (await deps.tg.answerCallbackQuery(cq.id));
  const now = deps.now();
  const user = await upsertUser(deps.db, cq.from, now);
  const m = messages(user.language);
  if (user.is_blocked) return void (await deps.tg.answerCallbackQuery(cq.id, m.blocked(user.block_reason).replace(/<[^>]+>/g, ""), true));
  const flood = await rateLimit(deps.db, `cb:${user.tg_user_id}`, 90, 60, now);
  if (!flood.allowed) return void (await deps.tg.answerCallbackQuery(cq.id, m.rateLimited(flood.retryAfterSeconds).replace(/<[^>]+>/g, ""), true));

  switch (parsed.kind) {
    case "job":
      return handleJobAction(deps, cq, user, parsed.action, parsed.shortId, parsed.arg);
    case "setting":
      return handleSettingCallback(deps, cq, user, parsed.key, parsed.value);
    case "history":
      return handleHistoryCallback(deps, cq, user, parsed.sub, parsed.arg);
    case "admin":
      return handleAdminCallback(deps, cq, user, parsed.sub, parsed.arg);
  }
}
