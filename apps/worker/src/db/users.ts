import type { UserRow, UserSettings, UserState } from "./types";
import { parseSettings, UserStateSchema } from "./types";

export interface TelegramUserInfo {
  id: number;
  username?: string | undefined;
  first_name?: string | undefined;
}

/** Create the user on first contact, refresh name/last_seen afterwards. */
export async function upsertUser(db: D1Database, u: TelegramUserInfo, now: number): Promise<UserRow> {
  await db
    .prepare(
      `INSERT INTO users (tg_user_id, username, first_name, created_at, last_seen_at)
       VALUES (?1, ?2, ?3, ?4, ?4)
       ON CONFLICT(tg_user_id) DO UPDATE SET username = ?2, first_name = ?3, last_seen_at = ?4`,
    )
    .bind(u.id, u.username ?? null, u.first_name ?? null, now)
    .run();
  const row = await getUser(db, u.id);
  if (!row) throw new Error("user upsert failed");
  return row;
}

export async function getUser(db: D1Database, id: number): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE tg_user_id = ?").bind(id).first<UserRow>();
}

export async function updateSettings(db: D1Database, id: number, patch: Partial<UserSettings>): Promise<UserSettings> {
  const row = await getUser(db, id);
  const merged = { ...parseSettings(row?.settings_json), ...patch };
  const validated = parseSettings(JSON.stringify(merged));
  await db.prepare("UPDATE users SET settings_json = ? WHERE tg_user_id = ?").bind(JSON.stringify(validated), id).run();
  return validated;
}

export async function setLanguage(db: D1Database, id: number, language: "fa" | "en"): Promise<void> {
  await db.prepare("UPDATE users SET language = ? WHERE tg_user_id = ?").bind(language, id).run();
}

export const STATE_TTL_SECONDS = 15 * 60;

export async function setUserState(db: D1Database, id: number, state: UserState | null, now: number): Promise<void> {
  if (!state) {
    await db.prepare("UPDATE users SET state = NULL, state_json = NULL, state_updated_at = NULL WHERE tg_user_id = ?").bind(id).run();
    return;
  }
  await db
    .prepare("UPDATE users SET state = ?, state_json = ?, state_updated_at = ? WHERE tg_user_id = ?")
    .bind(state.kind, JSON.stringify(state), now, id)
    .run();
}

/** The pending "waiting for input" state, or null when none or older than 15 minutes. */
export function readUserState(user: UserRow, now: number): UserState | null {
  if (!user.state || !user.state_json || !user.state_updated_at) return null;
  if (now - user.state_updated_at > STATE_TTL_SECONDS) return null;
  try {
    const parsed = UserStateSchema.safeParse(JSON.parse(user.state_json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function blockUser(db: D1Database, id: number, reason: string | null): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (tg_user_id, is_blocked, block_reason, created_at, last_seen_at) VALUES (?1, 1, ?2, strftime('%s','now'), strftime('%s','now'))
       ON CONFLICT(tg_user_id) DO UPDATE SET is_blocked = 1, block_reason = ?2`,
    )
    .bind(id, reason)
    .run();
}

export async function unblockUser(db: D1Database, id: number): Promise<void> {
  await db.prepare("UPDATE users SET is_blocked = 0, block_reason = NULL WHERE tg_user_id = ?").bind(id).run();
}

export async function listBlockedUsers(db: D1Database, limit = 30): Promise<UserRow[]> {
  const { results } = await db.prepare("SELECT * FROM users WHERE is_blocked = 1 ORDER BY last_seen_at DESC LIMIT ?").bind(limit).all<UserRow>();
  return results;
}

export async function countUsers(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
  return row?.n ?? 0;
}

export async function listAllUserIds(db: D1Database, afterId: number, limit: number): Promise<number[]> {
  const { results } = await db
    .prepare("SELECT tg_user_id FROM users WHERE is_blocked = 0 AND tg_user_id > ? ORDER BY tg_user_id LIMIT ?")
    .bind(afterId, limit)
    .all<{ tg_user_id: number }>();
  return results.map((r) => r.tg_user_id);
}
