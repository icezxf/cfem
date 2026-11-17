import { Alist } from "./alist";
import { authenticate, createToken, getSetting, setSetting, updatePassword, userByToken } from "./db";
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

export async function webConfig(request: Request, env: Env): Promise<Response> {
  const user = await requireAdmin(request, env);
  if (!user) return json({ error: "forbidden" }, 403);
  const url = (await getSetting(env, "alist_url")) || env.ALIST_URL || "";
  const token = (await getSetting(env, "alist_token")) || env.ALIST_TOKEN || "";
  return json({ alistConfigured: Boolean(url && token), alistUrl: url, version: "0.1.0" });
}

export async function webSaveSettings(request: Request, env: Env): Promise<Response> {
  const user = await requireAdmin(request, env);
  if (!user) return json({ error: "forbidden" }, 403);
  const body = (await request.json().catch(() => ({}))) as { alistUrl?: string; alistToken?: string };
  const url = (body.alistUrl || "").trim().replace(/\/+$/, "");
  const token = (body.alistToken || "").trim();
  if (url && !/^https?:\/\//i.test(url)) return json({ error: "AList 地址必须以 http:// 或 https:// 开头" }, 400);
  if (url) await setSetting(env, "alist_url", url);
  if (token) await setSetting(env, "alist_token", token);
  return webConfig(request, env);
}

export async function webChangePassword(request: Request, env: Env): Promise<Response> {
  const user = await requireAdmin(request, env);
  if (!user) return json({ error: "forbidden" }, 403);
  const body = (await request.json().catch(() => ({}))) as { oldPassword?: string; newPassword?: string };
  if (!body.newPassword || body.newPassword.length < 4) return json({ error: "新密码至少 4 位" }, 400);
  const verified = await authenticate(env, user.username, body.oldPassword || "");
  if (!verified) return json({ error: "旧密码错误" }, 400);
  await updatePassword(env, user.id, body.newPassword);
  return json({ status: "ok" });
}

export async function webAlistList(request: Request, env: Env): Promise<Response> {
  const user = await requireAdmin(request, env);
  if (!user) return json({ error: "forbidden" }, 403);
  const url = new URL(request.url);
  const path = url.searchParams.get("path") || "/";
  try {
    const data = await (await Alist.fromEnv(env)).list(path, 1, 1000);
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
    const running = await env.DB.prepare(
      "SELECT id, library_id FROM scan_jobs WHERE library_id = ?1 AND status = 'running' ORDER BY id DESC LIMIT 1",
    ).bind(libraryId).first<{ id: number; library_id: number }>();
    if (running) {
      return json({ id: running.id, library_id: running.library_id, status: "running", resumed: true });
    }
    const id = await createScan(env, libraryId);
    return json({ id, library_id: libraryId, status: "running" });
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

export async function webDebug(request: Request, env: Env): Promise<Response> {
  const user = await requireAdmin(request, env);
  if (!user) return json({ error: "forbidden" }, 403);
  const libraries = await env.DB.prepare(
    "SELECT l.*, (SELECT COUNT(*) FROM items i WHERE i.library_id = l.id) AS item_count FROM libraries l ORDER BY l.id",
  ).all();
  const total = await env.DB.prepare("SELECT COUNT(*) AS c FROM items").first<{ c: number }>();
  const jobs = await env.DB.prepare("SELECT * FROM scan_jobs ORDER BY id DESC LIMIT 5").all();
  const sample = await env.DB.prepare(
    `SELECT id, title, type, strm_path, strm_url, poster, plot, year
       FROM items
      ORDER BY (poster IS NULL AND plot IS NULL) ASC, id DESC
      LIMIT 5`,
  ).all();
  const metaCount = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM items WHERE poster IS NOT NULL OR plot IS NOT NULL",
  ).first<{ c: number }>();
  let posterCheck: Record<string, unknown> = {};
  const withPoster = sample.results.find((item: any) => item.poster);
  if (withPoster) {
    try {
      const client = await Alist.fromEnv(env);
      const stat = await client.stat((withPoster as any).poster);
      posterCheck = { ok: true, path: (withPoster as any).poster, size: stat.size };
    } catch (e) {
      posterCheck = { ok: false, path: (withPoster as any).poster, error: e instanceof Error ? e.message : String(e) };
    }
  }
  let alist: Record<string, unknown> = { ok: false };
  try {
    const client = await Alist.fromEnv(env);
    const data = await client.list("/", 1, 5);
    alist = { ok: true, entries: data.entries.map((e) => ({ name: e.name, is_dir: e.is_dir })) };
  } catch (e) {
    alist = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  let streamCheck: Record<string, unknown> = {};
  const withUrl = sample.results.find((item: any) => item.strm_url);
  if (withUrl) {
    try {
      const response = await fetch((withUrl as any).strm_url, {
        method: "HEAD",
        redirect: "manual",
        headers: { "User-Agent": "cfem/0.1" },
      });
      streamCheck = {
        ok: response.status >= 200 && response.status < 400,
        status: response.status,
        location: response.headers.get("Location"),
        contentType: response.headers.get("Content-Type"),
      };
    } catch (e) {
      streamCheck = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  const configuredUrl = (await getSetting(env, "alist_url")) || env.ALIST_URL || "";
  const configuredToken = (await getSetting(env, "alist_token")) || env.ALIST_TOKEN || "";
  return json({
    alistConfigured: Boolean(configuredUrl && configuredToken),
    alist,
    items: total?.c ?? 0,
    metaItems: metaCount?.c ?? 0,
    libraries: libraries.results,
    jobs: jobs.results,
    sampleItems: sample.results,
    posterCheck,
    streamCheck,
  });
}
