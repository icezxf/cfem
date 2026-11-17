import type { Env, SessionRow, UserRow } from "./types";
import { nowSec, randomId, sha256 } from "./util";

export async function ensureAdmin(env: Env): Promise<void> {
  const admin = await env.DB.prepare(
    "SELECT id, password_hash FROM users WHERE username = 'admin'",
  ).first<{ id: number; password_hash: string }>();

  if (!admin) {
    const hash = await sha256(env.ADMIN_PASSWORD || "admin");
    await env.DB.prepare(
      "INSERT OR IGNORE INTO users (username, password_hash, is_admin) VALUES (?1, ?2, 1)",
    ).bind("admin", hash).run();
    return;
  }

  // 以 ADMIN_PASSWORD secret 为准：改过 secret 后无需手动改库
  if (env.ADMIN_PASSWORD) {
    const hash = await sha256(env.ADMIN_PASSWORD);
    if (admin.password_hash !== hash) {
      await env.DB.prepare("UPDATE users SET password_hash = ?1, is_admin = 1 WHERE id = ?2")
        .bind(hash, admin.id).run();
    }
  }
}

export async function authenticate(env: Env, username: string, password: string): Promise<UserRow | null> {
  await ensureAdmin(env);
  const hash = await sha256(password);
  return env.DB.prepare(
    "SELECT id, username, password_hash, is_admin FROM users WHERE username = ?1 AND password_hash = ?2",
  ).bind(username, hash).first<UserRow>();
}

export async function createToken(env: Env, user: UserRow, sessionId: string): Promise<string> {
  const token = randomId();
  const now = nowSec();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM tokens WHERE created_at < ?1").bind(now - 30 * 86400),
    env.DB.prepare(
      "INSERT INTO tokens (token, user_id, session_id, created_at) VALUES (?1, ?2, ?3, ?4)",
    ).bind(token, user.id, sessionId, now),
  ]);
  return token;
}

export async function userByToken(env: Env, token: string): Promise<UserRow | null> {
  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.password_hash, u.is_admin
       FROM tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token = ?1 AND t.created_at >= ?2`,
  ).bind(token, nowSec() - 30 * 86400).first<UserRow>();
  if (!row) {
    await env.DB.prepare("DELETE FROM tokens WHERE token = ?1").bind(token).run();
  }
  return row ?? null;
}

export async function deleteToken(env: Env, token: string): Promise<void> {
  await env.DB.prepare("DELETE FROM tokens WHERE token = ?1").bind(token).run();
}

export async function createSession(
  env: Env,
  user: UserRow,
  client: string,
  device: string,
): Promise<string> {
  const id = randomId();
  const now = nowSec();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE last_activity < ?1").bind(now - 86400),
    env.DB.prepare(
      `INSERT INTO sessions (id, user_id, user_name, client, device, last_activity)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(id, user.id, user.username, client, device, now),
  ]);
  return id;
}

export async function updatePlaying(
  env: Env,
  userId: number,
  itemId: number,
  positionTicks: number,
  isPaused: boolean,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE sessions
        SET now_playing = ?1, position_ticks = ?2, is_paused = ?3, last_activity = ?4
      WHERE user_id = ?5
        AND id = (SELECT id FROM sessions WHERE user_id = ?5 ORDER BY last_activity DESC LIMIT 1)`,
  ).bind(itemId, positionTicks, isPaused ? 1 : 0, nowSec(), userId).run();
}

export async function stopPlaying(env: Env, userId: number): Promise<void> {
  await env.DB.prepare(
    "UPDATE sessions SET now_playing = NULL, position_ticks = 0, is_paused = 0, last_activity = ?1 WHERE user_id = ?2",
  ).bind(nowSec(), userId).run();
}

export async function listSessions(env: Env, userId: number, isAdmin: boolean): Promise<SessionRow[]> {
  const sql = isAdmin
    ? "SELECT * FROM sessions ORDER BY last_activity DESC"
    : "SELECT * FROM sessions WHERE user_id = ?1 ORDER BY last_activity DESC";
  const stmt = env.DB.prepare(sql);
  const result = isAdmin ? await stmt.all<SessionRow>() : await stmt.bind(userId).all<SessionRow>();
  return result.results;
}

export async function removeUserSessions(env: Env, userId: number): Promise<void> {
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(userId).run();
}
