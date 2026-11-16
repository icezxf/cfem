import { Alist } from "./alist";
import { authenticate, createToken, userByToken } from "./db";
import { createScan, stepScan } from "./scan";
import type { Env, ItemRow, LibraryRow, UserRow } from "./types";
import { json, nowSec, tokenFromRequest } from "./util";

async function requireAdmin(request: Request, env: Env): Promise<UserRow | null> {
  const token = tokenFromRequest(request);
  if (!token) return null;
  const user = await userByToken(env, token);
  return user && user.is_admin === 1 ? user : null;
}

export async function webLogin(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { username?: string; password?: string };
  const user = await authenticate(env, body.username || "", body.password || "");
  if (!user || user.is_admin !== 1) return json({ error: "用户名或密码错误" }, 401);
  const sessionId = crypto.randomUUID();
  const token = await createToken(env, user, sessionId);
  return json({ token, user: { id: user.id, username: user.username } });
}

export async function webConfig(env: Env): Promise<Response> {
  return json({
    alistConfigured: Boolean(env.ALIST_URL && env.ALIST_TOKEN),
    alistUrl: env.ALIST_URL || "",
    version: "0.1.0",
  });
}

export async function webAlistList(request: Request, env: Env): Promise<Response> {
  const user = await requireAdmin(request, env);
  if (!user) return json({ error: "forbidden" }, 403);
  const url = new URL(request.url);
  const path = url.searchParams.get("path") || "/";
  try {
    const data = await Alist.fromEnv(env).list(path, 1, 1000);
    return json({ path, entries: data.entries, total: data.total });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
}

export async function webLibraries(request: Request, env: Env): Promise<Response> {
  const user = await requireAdmin(request, env);
  if (!user) return json({ error: "forbidden" }, 403);
  if (request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { name?: string; type?: string; path?: string };
    const name = (body.name || "").trim();
    const type = body.type === "tvshows" ? "tvshows" : "movies";
    const path = (body.path || "/").trim();
    if (!name) return json({ error: "名称不能为空" }, 400);
    const row = await env.DB.prepare(
      "INSERT INTO libraries (name, type, path, created_at) VALUES (?1, ?2, ?3, ?4) RETURNING id",
    ).bind(name, type, path, nowSec()).run();
    return json({ id: row.meta.last_row_id, name, type, path });
  }
  const result = await env.DB.prepare("SELECT * FROM libraries ORDER BY id").all<LibraryRow>();
  return json({ libraries: result.results });
}

export async function webDeleteLibrary(request: Request, env: Env, id: number): Promise<Response> {
  const user = await requireAdmin(request, env);
  if (!user) return json({ error: "forbidden" }, 403);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM items WHERE library_id = ?1").bind(id),
    env.DB.prepare("DELETE FROM libraries WHERE id = ?1").bind(id),
  ]);
  return json({ status: "ok" });
}

export async function webScan(request: Request, env: Env, libraryId: number): Promise<Response> {
  const user = await requireAdmin(request, env);
  if (!user) return json({ error: "forbidden" }, 403);
  try {
    const id = await createScan(env, libraryId);
    return json({ id, status: "running" });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
}

export async function webScanStep(request: Request, env: Env, jobId: number): Promise<Response> {
  const user = await requireAdmin(request, env);
  if (!user) return json({ error: "forbidden" }, 403);
  const job = await stepScan(env, jobId);
  return job ? json(job) : json({ error: "not found" }, 404);
}

export async function webScanStatus(request: Request, env: Env, jobId: number): Promise<Response> {
  const user = await requireAdmin(request, env);
  if (!user) return json({ error: "forbidden" }, 403);
  const job = await env.DB.prepare("SELECT * FROM scan_jobs WHERE id = ?1").bind(jobId).first();
  return job ? json(job) : json({ error: "not found" }, 404);
}

export async function webItems(request: Request, env: Env): Promise<Response> {
  const user = await requireAdmin(request, env);
  if (!user) return json({ error: "forbidden" }, 403);
  const url = new URL(request.url);
  const libraryId = Number(url.searchParams.get("library_id") || 0);
  const limit = Math.min(120, Math.max(1, Number(url.searchParams.get("limit") || 60)));
  const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
  const where = libraryId ? "library_id = ?1" : "1=1";
  const params: unknown[] = libraryId ? [libraryId] : [];
  const total = await env.DB.prepare(`SELECT COUNT(*) AS c FROM items WHERE ${where}`).bind(...params).first<{ c: number }>();
  const rows = await env.DB.prepare(
    `SELECT * FROM items WHERE ${where} ORDER BY title LIMIT ? OFFSET ?`,
  ).bind(...params, limit, offset).all<ItemRow>();
  return json({ items: rows.results, total: total?.c ?? 0 });
}
