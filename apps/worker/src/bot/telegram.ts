/** Minimal typed Telegram Bot API client (JSON + multipart), with flood-wait and idempotent-edit handling. */

export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly description: string,
    readonly retryAfter?: number,
  ) {
    super(`${method}: ${status} ${description}`);
    this.name = "TelegramError";
  }

  /** Permanent: the user blocked the bot, deleted the chat, or the message is gone — retrying cannot help. */
  get isPermanent(): boolean {
    const d = this.description.toLowerCase();
    return (
      this.status === 403 ||
      d.includes("chat not found") ||
      d.includes("bot was blocked") ||
      d.includes("user is deactivated") ||
      d.includes("message to edit not found") ||
      d.includes("message can't be edited") ||
      d.includes("message to delete not found") ||
      d.includes("message is not modified")
    );
  }

  get isNotModified(): boolean {
    return this.description.toLowerCase().includes("message is not modified");
  }
}

export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}
export interface InlineKeyboard {
  inline_keyboard: InlineButton[][];
}
export interface ReplyKeyboard {
  keyboard: { text: string }[][];
  resize_keyboard?: boolean;
  is_persistent?: boolean;
  input_field_placeholder?: string;
}
export type ReplyMarkup = InlineKeyboard | ReplyKeyboard | { remove_keyboard: true };

export interface SendOptions {
  reply_markup?: ReplyMarkup | undefined;
  reply_to_message_id?: number | undefined;
  disable_notification?: boolean | undefined;
}

export interface TgMessage {
  message_id: number;
  chat: { id: number; type?: string };
  from?: { id: number; username?: string; first_name?: string };
  text?: string;
  caption?: string;
  photo?: { file_id: string; file_unique_id: string; width: number; height: number }[];
  entities?: { type: string; offset: number; length: number; url?: string }[];
  caption_entities?: { type: string; offset: number; length: number; url?: string }[];
}

export interface TgCallbackQuery {
  id: string;
  from: { id: number; username?: string; first_name?: string };
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

const REPLY_TARGET_GONE = /message to be replied not found|replied message not found/i;

export class Telegram {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly baseUrl = "https://api.telegram.org",
  ) {}

  private url(method: string): string {
    return `${this.baseUrl}/bot${this.token}/${method}`;
  }

  async call<T>(method: string, params: Record<string, unknown> = {}, opts: { retryFlood?: boolean } = {}): Promise<T> {
    const body = JSON.stringify(params);
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.fetchImpl(this.url(method), { method: "POST", headers: { "content-type": "application/json" }, body });
      const data = (await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }))) as {
        ok: boolean;
        result?: T;
        description?: string;
        error_code?: number;
        parameters?: { retry_after?: number };
      };
      if (data.ok) return data.result as T;
      const retryAfter = data.parameters?.retry_after;
      if (res.status === 429 && retryAfter !== undefined && retryAfter <= 3 && opts.retryFlood !== false && attempt === 0) {
        await new Promise((r) => setTimeout(r, (retryAfter + 0.2) * 1000));
        continue;
      }
      if (res.status === 400 && params.reply_to_message_id !== undefined && REPLY_TARGET_GONE.test(data.description ?? "")) {
        // the message we were answering was deleted in the meantime: send the answer without quoting it instead of losing it
        const { reply_to_message_id: _gone, ...withoutReply } = params;
        return this.call<T>(method, withoutReply, opts);
      }
      throw new TelegramError(method, res.status, data.description ?? "unknown error", retryAfter);
    }
    throw new TelegramError(method, 429, "flood control");
  }

  getMe() {
    return this.call<{ id: number; username: string; first_name: string }>("getMe");
  }

  sendMessage(chatId: number, text: string, opts: SendOptions = {}) {
    return this.call<TgMessage>("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...opts,
    });
  }

  /** Edit text; returns null when nothing changed or the message no longer exists. */
  async editMessageText(chatId: number, messageId: number, text: string, markup?: InlineKeyboard): Promise<TgMessage | null> {
    try {
      const result = await this.call<TgMessage | true>("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: markup ?? { inline_keyboard: [] },
      });
      return result === true ? null : result;
    } catch (e) {
      if (e instanceof TelegramError && e.isPermanent) return null;
      throw e;
    }
  }

  async editMessageCaption(chatId: number, messageId: number, caption: string, markup?: InlineKeyboard): Promise<void> {
    try {
      await this.call("editMessageCaption", {
        chat_id: chatId,
        message_id: messageId,
        caption,
        parse_mode: "HTML",
        reply_markup: markup ?? { inline_keyboard: [] },
      });
    } catch (e) {
      if (e instanceof TelegramError && e.isPermanent) return;
      throw e;
    }
  }

  async editReplyMarkup(chatId: number, messageId: number, markup: InlineKeyboard): Promise<void> {
    try {
      await this.call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: markup });
    } catch (e) {
      if (e instanceof TelegramError && e.isPermanent) return;
      throw e;
    }
  }

  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    try {
      await this.call("deleteMessage", { chat_id: chatId, message_id: messageId });
    } catch (e) {
      if (e instanceof TelegramError && (e.isPermanent || e.status === 400)) return;
      throw e;
    }
  }

  async answerCallbackQuery(id: string, text?: string, alert = false): Promise<void> {
    try {
      await this.call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text: text.slice(0, 200), show_alert: alert } : {}) }, { retryFlood: false });
    } catch (e) {
      if (e instanceof TelegramError) return; // an expired query id must never break the handler
      throw e;
    }
  }

  /** Photo by URL or file_id. */
  sendPhoto(chatId: number, photo: string, caption: string, opts: SendOptions = {}) {
    return this.call<TgMessage>("sendPhoto", { chat_id: chatId, photo, caption, parse_mode: "HTML", ...opts });
  }

  /** Several JPEGs (preview frames) uploaded as an album. */
  async sendPhotoAlbum(chatId: number, photos: { bytes: Uint8Array; caption: string }[], replyTo?: number): Promise<TgMessage[]> {
    const media = photos.map((p, i) => ({ type: "photo", media: `attach://p${i}`, caption: p.caption, parse_mode: "HTML" }));
    const build = (reply?: number) => {
      const form = new FormData();
      form.set("chat_id", String(chatId));
      if (reply) form.set("reply_to_message_id", String(reply));
      form.set("media", JSON.stringify(media));
      photos.forEach((p, i) => form.set(`p${i}`, new Blob([p.bytes], { type: "image/jpeg" }), `frame${i}.jpg`));
      return form;
    };
    type Reply = { ok: boolean; result?: TgMessage[]; description?: string; parameters?: { retry_after?: number } };
    let res = await this.fetchImpl(this.url("sendMediaGroup"), { method: "POST", body: build(replyTo) });
    let data = (await res.json().catch(() => ({ ok: false }))) as Reply;
    if (!data.ok && replyTo && res.status === 400 && REPLY_TARGET_GONE.test(data.description ?? "")) {
      res = await this.fetchImpl(this.url("sendMediaGroup"), { method: "POST", body: build() });
      data = (await res.json().catch(() => ({ ok: false }))) as Reply;
    }
    if (!data.ok) throw new TelegramError("sendMediaGroup", res.status, data.description ?? "unknown error", data.parameters?.retry_after);
    return data.result ?? [];
  }

  sendChatAction(chatId: number, action: string) {
    return this.call("sendChatAction", { chat_id: chatId, action }, { retryFlood: false }).catch(() => undefined);
  }

  setWebhook(url: string, secretToken: string) {
    return this.call<boolean>("setWebhook", {
      url,
      secret_token: secretToken,
      allowed_updates: ["message", "callback_query"],
      max_connections: 40,
      drop_pending_updates: false,
    });
  }

  deleteWebhook(dropPending = false) {
    return this.call<boolean>("deleteWebhook", { drop_pending_updates: dropPending });
  }

  getWebhookInfo() {
    return this.call<{ url: string; pending_update_count: number; last_error_date?: number; last_error_message?: string }>("getWebhookInfo");
  }

  setMyCommands(commands: { command: string; description: string }[], languageCode?: string) {
    return this.call<boolean>("setMyCommands", { commands, ...(languageCode ? { language_code: languageCode } : {}) });
  }
}
