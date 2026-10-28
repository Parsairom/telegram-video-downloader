/** Admin announcements: sent in small batches by the per-minute cron so a big audience never blocks a request. */
import type { Deps } from "../app";
import { escapeHtml } from "../bot/format";
import { TelegramError } from "../bot/telegram";
import { deleteAppConfig, getAppConfig, setAppConfig } from "../db/misc";
import { listAllUserIds } from "../db/users";

interface ActiveBroadcast {
  text: string;
  afterId: number;
  sent: number;
  failed: number;
  adminId: number;
  startedAt: number;
}

const KEY = "announce_active";
const BATCH = 25; // stay well under Telegram's ~30 messages/second bulk limit
const MAX_BATCHES_PER_TICK = 6;

export async function startBroadcast(deps: Deps, adminId: number, text: string): Promise<void> {
  const state: ActiveBroadcast = { text, afterId: 0, sent: 0, failed: 0, adminId, startedAt: deps.now() };
  await setAppConfig(deps.db, KEY, JSON.stringify(state), adminId, deps.now());
}

export async function broadcastTick(deps: Deps): Promise<void> {
  const raw = (await getAppConfig(deps.db))[KEY];
  if (!raw) return;
  let state: ActiveBroadcast;
  try {
    state = JSON.parse(raw) as ActiveBroadcast;
  } catch {
    await deleteAppConfig(deps.db, KEY);
    return;
  }
  for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch++) {
    const ids = await listAllUserIds(deps.db, state.afterId, BATCH);
    if (ids.length === 0) {
      await deleteAppConfig(deps.db, KEY);
      await deps.tg.sendMessage(state.adminId, `📣 announcement finished: ${state.sent} delivered, ${state.failed} failed.`).catch(() => undefined);
      return;
    }
    await Promise.all(
      ids.map(async (id) => {
        try {
          await deps.tg.sendMessage(id, escapeHtml(state.text));
          state.sent++;
        } catch (error) {
          state.failed++;
          if (!(error instanceof TelegramError && error.isPermanent)) deps.log.debug("announcement send failed", { id, error });
        }
      }),
    );
    state.afterId = ids[ids.length - 1]!;
    await setAppConfig(deps.db, KEY, JSON.stringify(state), state.adminId, deps.now());
    await new Promise((r) => setTimeout(r, 1000));
  }
}
