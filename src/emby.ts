import { Alist } from "./alist";
import {
  authenticate,
  createSession,
  createToken,
  deleteToken,
  listSessions,
  removeUserSessions,
  stopPlaying,
  updatePlaying,
  userByToken,
} from "./db";
import type { Env, ItemRow, LibraryRow, SessionRow, UserRow } from "./types";
import { intParam, isoDate, json, nowSec, tokenFromRequest } from "./util";

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

function itemType(type: string): string {
  return type;
}

function isFolder(type: string): boolean {
  return type === "Series" || type === "Season";
}

function itemDto(row: ItemRow): Record<string, unknown> {
  const ticks = Math.max(0, row.runtime) * 10_000_000;
  const type = itemType(row.type);
  return {
    Name: row.title,
    Id: String(row.id),
    ServerId: "cfem",
    Type: type,
    IsFolder: isFolder(type),
    MediaType: "Video",
    ProductionYear: Number(row.year) || 0,
    Overview: row.plot || "",
    CommunityRating: 0,
    RunTimeTicks: ticks,
    Size: row.size || 0,
    DateCreated: isoDate(row.mtime || nowSec()),
    ImageTags: row.poster ? { Primary: `tag_${row.id}` } : {},
    BackdropImageTags: row.fanart ? [`backdrop_${row.id}`] : [],
    Path: row.strm_url || row.strm_path,
    SeriesId: row.series_id ? String(row.series_id) : null,
    SeasonId:
      type === "Episode"
        ? row.parent_id
          ? String(row.parent_id)
          : null
        : type === "Season"
          ? String(row.id)
          : null,
    IndexNumber: type === "Episode" ? row.episode_number : type === "Season" ? row.season_number : null,
    ParentIndexNumber: type === "Episode" ? row.season_number : null,
    SeasonName: type === "Episode" ? `Season ${row.season_number || 1}` : null,
    Genres: row.genres ? row.genres.split(" / ") : [],
    Tags: row.tags ? row.tags.split(" / ") : [],
    MediaSources: [
      {
        Id: String(row.id),
        Protocol: "Http",
        SupportsDirectPlay: true,
        Container: "mp4",
        Size: row.size || 0,
        RunTimeTicks: ticks,
        Type: "Default",
        Name: "Direct Play",
      },
    ],
    UserData: {
      Played: false,
      PlayCount: 0,
      IsFavorite: false,
      PlaybackPositionTicks: 0,
      PlayedPercentage: 0,
    },
  };
}

function viewDto(library: LibraryRow): Record<string, unknown> {
  return {
    Name: library.name,
    Id: `lib_${library.id}`,
    ServerId: "cfem",
    Type: "CollectionFolder",
    IsFolder: true,
    MediaType: "Video",
    CollectionType: library.type === "movies" ? "movies" : "tvshows",
    ImageTags: {},
    UserData: { Played: false, PlayCount: 0, IsFavorite: false, PlaybackPositionTicks: 0 },
  };
}

function publicUser(user: UserRow): Record<string, unknown> {
  return {
    Id: String(user.id),
    Name: user.username,
    ServerId: "cfem",
    HasPassword: true,
    HasConfiguredPassword: true,
    PrimaryImageTag: null,
  };
}

function policy(admin: boolean): Record<string, unknown> {
  return {
    IsAdministrator: admin,
    IsHidden: false,
    IsDisabled: false,
    EnableAllFolders: true,
    EnabledFolders: [],
    EnableMediaPlayback: true,
    EnableAudioPlaybackTranscoding: true,
    EnableVideoPlaybackTranscoding: true,
    EnablePlaybackRemuxing: true,
    EnableContentDownloading: true,
    EnableSyncTranscoding: true,
    EnableSubtitleDownloading: true,
    EnableSubtitleManagement: true,
    EnableRemoteAccess: true,
    EnableAllDevices: true,
  };
}

function userDto(user: UserRow): Record<string, unknown> {
  return {
    Id: String(user.id),
    Name: user.username,
    ServerId: "cfem",
    HasPassword: true,
    HasConfiguredPassword: true,
    Policy: policy(user.is_admin === 1),
  };
}

function clientInfo(headers: Headers): { client: string; device: string } {
  const directClient = headers.get("X-Emby-Client");
  const directDevice = headers.get("X-Emby-Device-Name") || headers.get("X-Emby-Device-Id");
  const auth = headers.get("X-Emby-Authorization") || "";
  const match = (key: string) => auth.match(new RegExp(`${key}="([^"]+)"`, "i"))?.[1];
  return {
    client: directClient || match("Client") || "unknown",
    device: directDevice || match("Device") || match("DeviceId") || "unknown",
  };
}

async function bodyJson(request: Request): Promise<Record<string, unknown>> {
  const type = request.headers.get("Content-Type") || "";
  if (type.includes("application/json")) {
    return await request.json<Record<string, unknown>>().catch(() => ({}));
  }
  if (type.includes("application/x-www-form-urlencoded")) {
    const text = await request.text();
    const data: Record<string, string> = {};
    new URLSearchParams(text).forEach((v, k) => (data[k] = v));
    return data;
  }
  return {};
}

export async function embyAuthenticate(request: Request, env: Env): Promise<Response> {
  const body = await bodyJson(request);
  const username = String(body.Username || body.username || "");
  const password = String(body.Pw || body.Password || body.password || "");
  const user = await authenticate(env, username, password);
  if (!user) return json({ error: "Invalid credentials" }, 401);
  const info = clientInfo(request.headers);
  const sessionId = await createSession(env, user, info.client, info.device);
  const token = await createToken(env, user, sessionId);
  return json({
    User: userDto(user),
    SessionInfo: { Id: sessionId, UserId: String(user.id), UserName: user.username, IsActive: true },
    AccessToken: token,
    ServerId: "cfem",
  });
}

export async function embyPublicUsers(env: Env): Promise<Response> {
  const result = await env.DB.prepare("SELECT * FROM users ORDER BY id").all<UserRow>();
  return json(result.results.map(publicUser));
}

export async function embyUser(env: Env, id: string): Promise<Response> {
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?1").bind(Number(id)).first<UserRow>();
  return user ? json(userDto(user)) : json({ error: "not found" }, 404);
}

export async function embyViews(env: Env, userId: string): Promise<Response> {
  const result = await env.DB.prepare("SELECT * FROM libraries ORDER BY id").all<LibraryRow>();
  return json({ Items: result.results.map(viewDto), TotalRecordCount: result.results.length });
}

export async function embyItems(env: Env, url: URL, user: UserRow): Promise<Response> {
  const parent = url.searchParams.get("ParentId") || "";
  const start = Math.max(0, intParam(url, "StartIndex", 0));
  const limit = Math.min(500, Math.max(1, intParam(url, "Limit", 100)));
  const search = (url.searchParams.get("SearchTerm") || "").trim();
  const types = (url.searchParams.get("IncludeItemTypes") || "").split(",").map((s) => s.trim()).filter(Boolean);

  let where = "1=1";
  const params: unknown[] = [];

  if (parent.startsWith("lib_")) {
    where += " AND library_id = ?";
    params.push(Number(parent.slice(4)));
    if (types.length === 0) {
      const library = await env.DB.prepare("SELECT type FROM libraries WHERE id = ?1")
        .bind(Number(parent.slice(4))).first<{ type: string }>();
      where += library?.type === "movies" ? " AND type = 'Movie'" : " AND type = 'Series'";
    }
  } else if (parent) {
    const parentRow = await env.DB.prepare("SELECT type FROM items WHERE id = ?1")
      .bind(Number(parent)).first<{ type: string }>();
    const wantsEpisodes = types.includes("Episode");
    if (parentRow?.type === "Series" && wantsEpisodes) {
      where += " AND series_id = ?";
      params.push(Number(parent));
    } else {
      where += " AND parent_id = ?";
      params.push(Number(parent));
    }
  }

  if (types.length > 0) {
    where += ` AND type IN (${types.map(() => "?").join(",")})`;
    params.push(...types);
  }
  if (search) {
    where += " AND title LIKE ?";
    params.push(`%${search}%`);
  }

  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS c FROM items WHERE ${where}`)
    .bind(...params).first<{ c: number }>();
  const rows = await env.DB.prepare(
    `SELECT * FROM items WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
  ).bind(...params, limit, start).all<ItemRow>();
  return json({ Items: rows.results.map(itemDto), TotalRecordCount: totalRow?.c ?? 0 });
}

export async function embyLatest(env: Env, url: URL): Promise<Response> {
  const limit = Math.min(30, Math.max(1, intParam(url, "Limit", 16)));
  const rows = await env.DB.prepare("SELECT * FROM items ORDER BY id DESC LIMIT ?")
    .bind(limit).all<ItemRow>();
  return json(rows.results.map(itemDto));
}

export async function embyItemDetail(env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT * FROM items WHERE id = ?1").bind(Number(id)).first<ItemRow>();
  if (!row) return json({ error: "not found" }, 404);
  const dto = itemDto(row);
  dto.MediaSources = row.type === "Movie" || row.type === "Episode" ? dto.MediaSources : [];
  return json(dto);
}

export async function embySeasons(env: Env, seriesId: string): Promise<Response> {
  const rows = await env.DB.prepare("SELECT * FROM items WHERE type = 'Season' AND parent_id = ?1 ORDER BY season_number")
    .bind(Number(seriesId)).all<ItemRow>();
  return json({ Items: rows.results.map(itemDto), TotalRecordCount: rows.results.length });
}

export async function embyEpisodes(env: Env, seriesId: string, url: URL): Promise<Response> {
  const seasonId = url.searchParams.get("SeasonId");
  const rows = seasonId
    ? await env.DB.prepare("SELECT * FROM items WHERE type = 'Episode' AND parent_id = ?1 ORDER BY episode_number")
        .bind(Number(seasonId)).all<ItemRow>()
    : await env.DB.prepare("SELECT * FROM items WHERE type = 'Episode' AND series_id = ?1 ORDER BY season_number, episode_number")
        .bind(Number(seriesId)).all<ItemRow>();
  return json({ Items: rows.results.map(itemDto), TotalRecordCount: rows.results.length });
}

export async function embyImage(env: Env, id: string, type: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT poster, fanart FROM items WHERE id = ?1")
    .bind(Number(id)).first<{ poster: string | null; fanart: string | null }>();
  const path = type.toLowerCase().startsWith("backdrop") || type.toLowerCase() === "fanart" ? row?.fanart : row?.poster;
  if (path) {
    try {
      if (/^https?:\/\//i.test(path)) {
        const response = await fetch(path);
        if (response.ok) {
          return new Response(response.body, {
            headers: { "Content-Type": response.headers.get("Content-Type") || "image/jpeg", "Cache-Control": "public, max-age=3600" },
          });
        }
      } else {
        const response = await (await Alist.fromEnv(env)).readBinary(path);
        if (response.ok) {
          return new Response(response.body, {
            headers: { "Content-Type": response.headers.get("Content-Type") || "image/jpeg", "Cache-Control": "public, max-age=3600" },
          });
        }
      }
    } catch {
      // fall through to placeholder
    }
  }
  return new Response(PNG, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" } });
}

export async function embyPlaybackInfo(env: Env, id: string, token: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT * FROM items WHERE id = ?1").bind(Number(id)).first<ItemRow>();
  if (!row) return json({ error: "not found" }, 404);
  const direct = `/emby/Videos/${row.id}/stream?api_key=${encodeURIComponent(token)}`;
  return json({
    MediaSources: [
      {
        Id: String(row.id),
        Path: row.strm_url || row.strm_path,
        DirectStreamUrl: direct,
        Protocol: "Http",
        Container: "mp4",
        Name: "Direct Play",
        Type: "Default",
        IsRemote: true,
        RunTimeTicks: Math.max(0, row.runtime) * 10_000_000,
        Size: row.size || 0,
        SupportsDirectPlay: true,
        SupportsDirectStream: true,
        SupportsProbing: true,
        SupportsTranscoding: false,
        MediaStreams: [],
      },
    ],
    PlaySessionId: crypto.randomUUID(),
  });
}

async function resolvePlaybackUrl(url: string, userAgent: string, referer?: string | null): Promise<string | null> {
  if (!/^https?:\/\//i.test(url)) return url;
  const headers: Record<string, string> = {
    "User-Agent": userAgent,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,video/*;q=0.8,*/*;q=0.7",
  };
  if (referer) headers.Referer = referer;
  const response = await fetch(url, {
    redirect: "manual",
    headers,
  });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("Location");
    return location ? new URL(location, url).toString() : null;
  }
  if (response.status === 200) {
    const contentType = response.headers.get("Content-Type") || "";
    if (!contentType.includes("text/html")) return url;
  }
  const body = await response.text();
  const href = body.match(/href="([^"]+)"/i);
  if (href) {
    try {
      return new URL(href[1].replace(/&amp;/g, "&"), url).toString();
    } catch {
      return null;
    }
  }
  const trimmed = body.trim().replace(/&amp;/g, "&");
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

export async function embyStream(request: Request, env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT * FROM items WHERE id = ?1").bind(Number(id)).first<ItemRow>();
  if (!row) return new Response("not found", { status: 404 });
  let url = (row.strm_url || "").replace(/&amp;/g, "&");
  if (!url && row.strm_path) {
    try {
      const content = await (await Alist.fromEnv(env)).readText(row.strm_path);
      url = content.split(/\r?\n/).map((s) => s.trim()).find((s) => /^https?:\/\//i.test(s)) || "";
    } catch {
      return new Response("strm read failed", { status: 404 });
    }
  }
  if (!url) return new Response("no url", { status: 404 });
  const target = await resolvePlaybackUrl(
    url,
    request.headers.get("User-Agent") || "Mozilla/5.0",
    request.headers.get("Referer"),
  );
  if (!target) return new Response("resolve failed", { status: 502 });
  return new Response(null, {
    status: 302,
    headers: { Location: target, "Cache-Control": "no-store" },
  });
}

export async function embySessions(env: Env, user: UserRow): Promise<Response> {
  const sessions = await listSessions(env, user.id, user.is_admin === 1);
  const items = await Promise.all(sessions.map(async (session: SessionRow) => {
    let nowPlaying = null;
    if (session.now_playing) {
      const item = await env.DB.prepare("SELECT id, title, type FROM items WHERE id = ?1")
        .bind(session.now_playing).first<{ id: number; title: string; type: string }>();
      if (item) nowPlaying = { Id: String(item.id), Name: item.title, Type: item.type, ServerId: "cfem" };
    }
    return {
      Id: session.id,
      UserId: String(session.user_id),
      UserName: session.user_name,
      Client: session.client || "unknown",
      DeviceName: session.device || "unknown",
      LastActivityDate: isoDate(session.last_activity),
      NowPlayingItem: nowPlaying,
      PlayState: { PositionTicks: session.position_ticks, IsPaused: session.is_paused === 1 },
      SupportsRemoteControl: false,
    };
  }));
  return json(items);
}

export async function embyPlaying(request: Request, env: Env, user: UserRow, stop = false): Promise<Response> {
  if (stop) {
    await stopPlaying(env, user.id);
    return new Response(null, { status: 204 });
  }
  const body = await bodyJson(request);
  const itemId = Number(body.ItemId);
  if (Number.isFinite(itemId) && itemId > 0) {
    const position = Number(body.PositionTicks) || 0;
    const paused = body.IsPaused === true;
    await updatePlaying(env, user.id, itemId, position, paused);
    await env.DB.prepare(
      `INSERT INTO user_data (user_id, item_id, position_ticks, last_played)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(user_id, item_id) DO UPDATE SET position_ticks = excluded.position_ticks, last_played = excluded.last_played`,
    ).bind(user.id, itemId, position, nowSec()).run();
  }
  return new Response(null, { status: 204 });
}

export async function embyFilters(env: Env, url: URL): Promise<Response> {
  const parent = url.searchParams.get("ParentId") || "";
  const libId = parent.startsWith("lib_") ? Number(parent.slice(4)) : null;
  const years = libId
    ? await env.DB.prepare("SELECT DISTINCT year FROM items WHERE library_id = ?1 AND year IS NOT NULL AND year != ''")
        .bind(libId).all<{ year: string }>()
    : await env.DB.prepare("SELECT DISTINCT year FROM items WHERE year IS NOT NULL AND year != ''").all<{ year: string }>();
  return json({
    Genres: [],
    Tags: [],
    OfficialRatings: [],
    Years: years.results.map((r) => Number(r.year)).filter((n) => n > 0).sort((a, b) => b - a),
  });
}

export async function embyLogout(request: Request, env: Env): Promise<Response> {
  const token = tokenFromRequest(request);
  if (token) {
    const user = await userByToken(env, token);
    if (user) await removeUserSessions(env, user.id);
    await deleteToken(env, token);
  }
  return new Response(null, { status: 204 });
}

export async function requireUser(request: Request, env: Env): Promise<UserRow | null> {
  const token = tokenFromRequest(request);
  return token ? await userByToken(env, token) : null;
}
