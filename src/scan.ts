import { Alist } from "./alist";
import type { Env, LibraryRow } from "./types";
import { nowSec } from "./util";

interface ScanJob {
  id: number;
  library_id: number;
  queue: string;
  status: string;
  scanned: number;
  total: number;
  error: string | null;
}

function joinPath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, "")}/${name}`.replace(/\/+/g, "/");
}

function cleanTitle(name: string): string {
  return name.replace(/\.strm$/i, "").replace(/[._]+/g, " ").trim();
}

function parseEpisode(name: string): { season: number; episode: number } | null {
  const match = name.match(/S(\d{1,2})[\s._-]*E(\d{1,3})/i) || name.match(/(\d{1,2})x(\d{1,3})/i);
  if (!match) return null;
  return { season: Number(match[1]), episode: Number(match[2]) };
}

function seriesFromPath(path: string): { title: string; season: number } {
  const parts = path.split("/").filter(Boolean);
  const file = parts.pop() || "";
  let season = 1;
  let title = parts[parts.length - 1] || "未分类剧集";
  for (let i = parts.length - 1; i >= 0; i--) {
    const match = parts[i].match(/^(?:Season|S)\s*(\d{1,2})$/i);
    if (match) {
      season = Number(match[1]);
      title = parts[i - 1] || title;
      break;
    }
  }
  const parsed = parseEpisode(file);
  return { title, season: parsed?.season ?? season };
}

async function upsertItem(
  env: Env,
  libraryId: number,
  values: {
    title: string;
    type: string;
    strmPath: string;
    strmUrl?: string;
    poster?: string;
    fanart?: string;
    runtime?: number;
    size?: number;
    mtime?: number;
    seriesId?: number | null;
    seasonNumber?: number | null;
    episodeNumber?: number | null;
    parentId?: number | null;
  },
): Promise<number> {
  const now = nowSec();
  await env.DB.prepare(
    `INSERT INTO items
      (library_id, title, type, strm_path, strm_url, poster, fanart, runtime, size, mtime,
       series_id, season_number, episode_number, parent_id, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
     ON CONFLICT(library_id, strm_path) DO UPDATE SET
       title = excluded.title,
       type = excluded.type,
       strm_url = COALESCE(excluded.strm_url, items.strm_url),
       poster = COALESCE(NULLIF(excluded.poster, ''), items.poster),
       fanart = COALESCE(NULLIF(excluded.fanart, ''), items.fanart),
       runtime = CASE WHEN excluded.runtime > 0 THEN excluded.runtime ELSE items.runtime END,
       size = CASE WHEN excluded.size > 0 THEN excluded.size ELSE items.size END,
       mtime = excluded.mtime,
       series_id = excluded.series_id,
       season_number = excluded.season_number,
       episode_number = excluded.episode_number,
       parent_id = excluded.parent_id,
       updated_at = excluded.updated_at`,
  ).bind(
    libraryId,
    values.title,
    values.type,
    values.strmPath,
    values.strmUrl ?? null,
    values.poster ?? null,
    values.fanart ?? null,
    values.runtime ?? 0,
    values.size ?? 0,
    values.mtime ?? 0,
    values.seriesId ?? null,
    values.seasonNumber ?? null,
    values.episodeNumber ?? null,
    values.parentId ?? null,
    now,
  ).run();
  const row = await env.DB.prepare("SELECT id FROM items WHERE library_id = ?1 AND strm_path = ?2")
    .bind(libraryId, values.strmPath).first<{ id: number }>();
  if (!row) throw new Error("写入媒体项失败");
  return row.id;
}

async function scanDirectory(
  env: Env,
  library: LibraryRow,
  alist: Alist,
  dir: string,
  queue: string[],
): Promise<number> {
  const { entries } = await alist.list(dir, 1, 1000);
  const images = entries.filter((e) => !e.is_dir && /\.(jpg|jpeg|png|webp)$/i.test(e.name));
  const poster = images.find((e) => /^poster\.(jpg|jpeg|png|webp)$/i.test(e.name))
    || images.find((e) => /-poster\./i.test(e.name));
  const fanart = images.find((e) => /^(fanart|backdrop)\.(jpg|jpeg|png|webp)$/i.test(e.name))
    || images.find((e) => /-fanart\./i.test(e.name));
  const posterPath = poster ? joinPath(dir, poster.name) : undefined;
  const fanartPath = fanart ? joinPath(dir, fanart.name) : undefined;

  let scanned = 0;
  for (const entry of entries) {
    const full = joinPath(dir, entry.name);
    if (entry.is_dir) {
      queue.push(full);
      continue;
    }
    if (!/\.strm$/i.test(entry.name)) continue;

    let url: string | undefined;
    try {
      const content = await alist.readText(full);
      url = content.split(/\r?\n/).map((line) => line.trim()).find((line) => /^https?:\/\//i.test(line));
    } catch {
      // 单个 strm 失败不应中断整个扫描
    }

    if (library.type === "movies") {
      await upsertItem(env, library.id, {
        title: cleanTitle(entry.name),
        type: "Movie",
        strmPath: full,
        strmUrl: url,
        poster: posterPath,
        fanart: fanartPath,
        size: entry.size,
        mtime: entry.modified && Number.isFinite(Date.parse(entry.modified))
          ? Math.floor(Date.parse(entry.modified) / 1000)
          : nowSec(),
      });
    } else {
      const parsed = parseEpisode(entry.name);
      const series = seriesFromPath(full);
      const seasonNumber = parsed?.season ?? series.season;
      const episodeNumber = parsed?.episode ?? 0;
      const seriesId = await upsertItem(env, library.id, {
        title: series.title,
        type: "Series",
        strmPath: `series:${series.title}`,
        poster: posterPath,
        fanart: fanartPath,
      });
      const seasonId = await upsertItem(env, library.id, {
        title: `Season ${seasonNumber}`,
        type: "Season",
        strmPath: `season:${series.title}:${seasonNumber}`,
        seriesId,
        parentId: seriesId,
        seasonNumber,
        poster: posterPath,
        fanart: fanartPath,
      });
      await upsertItem(env, library.id, {
        title: cleanTitle(entry.name),
        type: "Episode",
        strmPath: full,
        strmUrl: url,
        poster: posterPath,
        fanart: fanartPath,
        size: entry.size,
        mtime: entry.modified && Number.isFinite(Date.parse(entry.modified))
          ? Math.floor(Date.parse(entry.modified) / 1000)
          : nowSec(),
        seriesId,
        parentId: seasonId,
        seasonNumber,
        episodeNumber,
      });
    }
    scanned += 1;
  }
  return scanned;
}

export async function createScan(env: Env, libraryId: number): Promise<number> {
  const library = await env.DB.prepare("SELECT * FROM libraries WHERE id = ?1")
    .bind(libraryId).first<LibraryRow>();
  if (!library) throw new Error("媒体库不存在");
  const job = await env.DB.prepare(
    `INSERT INTO scan_jobs (library_id, queue, status, scanned, total, updated_at)
     VALUES (?1, ?2, 'running', 0, 0, ?3)`,
  ).bind(libraryId, JSON.stringify([library.path]), nowSec()).run();
  return job.meta.last_row_id;
}

export async function stepScan(env: Env, jobId: number): Promise<ScanJob | null> {
  const job = await env.DB.prepare("SELECT * FROM scan_jobs WHERE id = ?1")
    .bind(jobId).first<ScanJob>();
  if (!job) return null;
  if (job.status === "done" || job.status === "error") return job;

  const library = await env.DB.prepare("SELECT * FROM libraries WHERE id = ?1")
    .bind(job.library_id).first<LibraryRow>();
  if (!library) return job;

  const alist = Alist.fromEnv(env);
  const queue = JSON.parse(job.queue) as string[];
  let scanned = job.scanned;
  let processedDirs = 0;
  let error = job.error;

  try {
    while (queue.length > 0 && processedDirs < 3) {
      const dir = queue.shift()!;
      scanned += await scanDirectory(env, library, alist, dir, queue);
      processedDirs += 1;
    }
    const status = queue.length === 0 ? "done" : "running";
    await env.DB.prepare(
      "UPDATE scan_jobs SET queue = ?1, status = ?2, scanned = ?3, updated_at = ?4 WHERE id = ?5",
    ).bind(JSON.stringify(queue), status, scanned, nowSec(), job.id).run();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    await env.DB.prepare(
      "UPDATE scan_jobs SET status = 'error', error = ?1, updated_at = ?2 WHERE id = ?3",
    ).bind(error, nowSec(), job.id).run();
  }

  return env.DB.prepare("SELECT * FROM scan_jobs WHERE id = ?1").bind(job.id).first<ScanJob>();
}
