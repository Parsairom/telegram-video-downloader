/** Free-text replies while the bot is waiting for a title / file name / caption / metadata / thumbnail photo. */
import type { Deps } from "../app";
import type { Messages } from "../bot/i18n";
import { sanitizeFilename } from "../bot/format";
import type { TgMessage } from "../bot/telegram";
import { getJobByShortId, patchJob } from "../db/jobs";
import type { UserRow, UserState } from "../db/types";
import { setUserState, updateSettings } from "../db/users";
import { currentDraft, editMenu, renderCustomize } from "../services/menu";
import { captionFromUserText, type Draft } from "../services/selection";

const MAX_TITLE = 200;
const MAX_CAPTION = 900;

export async function handleStateInput(deps: Deps, user: UserRow, m: Messages, msg: TgMessage, state: UserState): Promise<void> {
  const { db, tg } = deps;
  const chatId = msg.chat.id;
  const clearState = () => setUserState(db, user.tg_user_id, null, deps.now());
  const text = (msg.text ?? "").trim();

  // account-level default caption (no job involved)
  if (state.kind === "await_default_caption") {
    if (!msg.text) return void (await tg.sendMessage(chatId, m.inputInvalid(m.askDefaultCaption)));
    if (text.length > MAX_CAPTION) return void (await tg.sendMessage(chatId, m.inputTooLong(MAX_CAPTION)));
    await updateSettings(db, user.tg_user_id, { defaultCaption: text === "-" ? null : text });
    await clearState();
    await tg.sendMessage(chatId, m.valueSaved);
    return;
  }

  const job = state.jobShortId ? await getJobByShortId(db, state.jobShortId) : null;
  if (!job || job.user_id !== user.tg_user_id || job.status !== "ready") {
    await clearState();
    await tg.sendMessage(chatId, m.menuExpired);
    return;
  }
  const draft = currentDraft(job);
  if (!draft) {
    await clearState();
    await tg.sendMessage(chatId, m.menuExpired);
    return;
  }

  let next: Draft = draft;
  switch (state.kind) {
    case "await_thumbnail": {
      const photo = msg.photo?.[msg.photo.length - 1];
      if (!photo) return void (await tg.sendMessage(chatId, m.inputInvalid(m.askThumbnail)));
      next = { ...draft, thumbnail: { mode: "custom", customFileId: photo.file_id } };
      break;
    }
    case "await_title": {
      if (!text || !msg.text) return void (await tg.sendMessage(chatId, m.inputInvalid(m.askTitle(draft.title))));
      if (text.length > MAX_TITLE) return void (await tg.sendMessage(chatId, m.inputTooLong(MAX_TITLE)));
      next = { ...draft, title: text };
      break;
    }
    case "await_filename": {
      const name = sanitizeFilename(text);
      if (!name) return void (await tg.sendMessage(chatId, m.inputInvalid(m.askFilename(draft.filename))));
      next = { ...draft, filename: name };
      break;
    }
    case "await_caption": {
      if (!text || !msg.text) return void (await tg.sendMessage(chatId, m.inputInvalid(m.askCaption(draft.caption))));
      if (text.length > MAX_CAPTION) return void (await tg.sendMessage(chatId, m.inputTooLong(MAX_CAPTION)));
      next = { ...draft, caption: captionFromUserText(text) };
      break;
    }
    case "await_embed_title": {
      if (!msg.text) return void (await tg.sendMessage(chatId, m.inputInvalid(m.askEmbedTitle)));
      if (text.length > MAX_TITLE) return void (await tg.sendMessage(chatId, m.inputTooLong(MAX_TITLE)));
      next = { ...draft, embedTitle: text === "-" ? null : text };
      await patchJob(db, job.id, { selection_json: JSON.stringify(next) }, deps.now());
      await setUserState(db, user.tg_user_id, { kind: "await_embed_artist", jobShortId: job.short_id }, deps.now());
      await tg.sendMessage(chatId, m.askEmbedArtist);
      return; // ask for the artist next; the menu refreshes after that answer
    }
    case "await_embed_artist": {
      if (!msg.text) return void (await tg.sendMessage(chatId, m.inputInvalid(m.askEmbedArtist)));
      if (text.length > 150) return void (await tg.sendMessage(chatId, m.inputTooLong(150)));
      next = { ...draft, embedArtist: text === "-" ? null : text };
      break;
    }
  }

  await patchJob(db, job.id, { selection_json: JSON.stringify(next) }, deps.now());
  await clearState();
  const fresh = { ...job, selection_json: JSON.stringify(next) };
  const rendered = await renderCustomize(deps, fresh, next);
  await editMenu(deps, fresh, rendered.text, rendered.markup);
  await tg.sendMessage(chatId, m.valueSaved);
}
