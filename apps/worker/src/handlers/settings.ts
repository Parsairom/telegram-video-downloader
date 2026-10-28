import type { Deps } from "../app";
import type { Messages } from "../bot/i18n";
import { messages } from "../bot/i18n";
import type { TgCallbackQuery } from "../bot/telegram";
import { parseSettings, type UserRow, type UserSettings } from "../db/types";
import { getUser, setLanguage, setUserState, updateSettings } from "../db/users";
import { settingsKeyboard } from "../keyboards";

const cycle = <T extends string>(values: readonly T[], current: T): T => values[(values.indexOf(current) + 1) % values.length] ?? values[0]!;

export async function showSettings(deps: Deps, user: UserRow, chatId: number, editMessageId?: number): Promise<void> {
  const fresh = (await getUser(deps.db, user.tg_user_id)) ?? user;
  const m = messages(fresh.language);
  const markup = settingsKeyboard(m, parseSettings(fresh.settings_json), fresh.language, deps.cfg);
  if (editMessageId) await deps.tg.editMessageText(chatId, editMessageId, m.settingsTitle, markup);
  else await deps.tg.sendMessage(chatId, m.settingsTitle, { reply_markup: markup });
}

export async function handleSettingCallback(deps: Deps, cq: TgCallbackQuery, user: UserRow, key: string, value: string): Promise<void> {
  const current = parseSettings(user.settings_json);
  const patch = ((): Partial<UserSettings> | "lang" | "edit_caption" | null => {
    switch (key) {
      case "res":
        return { defaultResolution: cycle(["ask", "best", "1080", "720", "480", "360"] as const, current.defaultResolution) };
      case "cont":
        return { defaultContainer: cycle(["auto", "mp4", "webm", "original"] as const, current.defaultContainer) };
      case "quick":
        return { quickStart: !current.quickStart };
      case "thumb":
        return { thumbnailMode: cycle(["original", "frame", "none"] as const, current.thumbnailMode) };
      case "deliv": {
        const modes: UserSettings["deliveryPreference"][] = [
          "auto",
          "bot_api_cloud",
          ...(deps.cfg.mtprotoEnabled ? (["mtproto"] as const) : []),
          ...(deps.cfg.localBotApiEnabled ? (["bot_api_local"] as const) : []),
          ...(deps.cfg.linkDeliveryEnabled ? (["r2_link"] as const) : []),
        ];
        return { deliveryPreference: cycle(modes, current.deliveryPreference) };
      }
      case "sendas":
        return { sendAs: current.sendAs === "document" ? "auto" : "document" };
      case "prog":
        return { progressUpdates: !current.progressUpdates };
      case "embed":
        return { embedMetadata: !current.embedMetadata };
      case "cap":
        return value === "edit" ? "edit_caption" : null;
      case "lang":
        return "lang";
      default:
        return null;
    }
  })();
  if (!patch) return void (await deps.tg.answerCallbackQuery(cq.id));

  let m: Messages = messages(user.language);
  if (patch === "lang") {
    const next = user.language === "en" ? "fa" : "en";
    await setLanguage(deps.db, user.tg_user_id, next);
    m = messages(next);
  } else if (patch === "edit_caption") {
    await setUserState(deps.db, user.tg_user_id, { kind: "await_default_caption", jobShortId: null }, deps.now());
    await deps.tg.sendMessage(cq.message?.chat.id ?? user.tg_user_id, m.askDefaultCaption);
    return void (await deps.tg.answerCallbackQuery(cq.id));
  } else {
    await updateSettings(deps.db, user.tg_user_id, patch);
  }
  if (cq.message) await showSettings(deps, user, cq.message.chat.id, cq.message.message_id);
  await deps.tg.answerCallbackQuery(cq.id, m.valueSaved);
}
