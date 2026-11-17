import {
  embyAuthenticate,
  embyEpisodes,
  embyFilters,
  embyImage,
  embyItemDetail,
  embyItems,
  embyLatest,
  embyLogout,
  embyPlaybackInfo,
  embyPlaying,
  embyPublicUsers,
  embySeasons,
  embySessions,
  embyStream,
  embyUser,
  embyViews,
  requireUser,
} from "./emby";
import type { Env } from "./types";
import { json, tokenFromRequest } from "./util";
import {
  webAlistList,
  webConfig,
  webDeleteLibrary,
  webItems,
  webLibraries,
  webLogin,
  webScan,
  webScanStatus,
  webScanStep,
  webSaveSettings,
  webChangePassword,
  webDebug,
} from "./web";

function systemInfo(): Response {
  return json({
    ServerName: "cfem",
    Version: "4.8.0.0",
    Id: "cfem-server",
    OperatingSystem: "Cloudflare Workers",
    OperatingSystemDisplayName: "Cloudflare Workers",
    HasPendingRestart: false,
    IsShuttingDown: false,
    SupportsLibraryMonitor: false,
    SupportsHttps: true,
    HttpServerPortNumber: 443,
  });
}

function publicInfo(): Response {
  return json({
    ServerName: "cfem",
    Version: "4.8.0.0",
    Id: "cfem-server",
    OperatingSystem: "Cloudflare Workers",
    StartupWizardCompleted: true,
  });
}

async function handleEmby(request: Request, env: Env, segments: string[]): Promise<Response> {
  const method = request.method;
  const path = `/${segments.join("/")}`;

  if (path === "/System/Info/Public") return publicInfo();
  if (path === "/System/Info") return systemInfo();
  if (path === "/System/Ping") return new Response("Emby Server", { status: 200 });
  if (path === "/Users/Public") return embyPublicUsers(env);
  if (path === "/Users/AuthenticateByName" && method === "POST") return embyAuthenticate(request, env);
  if (path === "/Auth/Keys") return json({ Items: [], TotalRecordCount: 0 });
  if (path === "/Sessions/Logout" && method === "POST") return embyLogout(request, env);
  if (path === "/DisplayPreferences/x") return json({ Id: "default", ViewType: "Poster", SortBy: "SortName" });

  const user = await requireUser(request, env);
  if (!user) return json({ error: "Unauthorized" }, 401);

  if (path === "/Sessions" && method === "GET") return embySessions(env, user);
  if (path === "/Sessions/Playing" && method === "POST") return embyPlaying(request, env, user);
  if (path === "/Sessions/Playing/Progress" && method === "POST") return embyPlaying(request, env, user);
  if (path === "/Sessions/Playing/Stopped" && method === "POST") return embyPlaying(request, env, user, true);

  if (path === "/Items/Filters" || path === "/Items/Filters2") return embyFilters(env, new URL(request.url));
  if (path === "/Genres" || path === "/Tags" || path === "/Studios" || path === "/OfficialRatings") {
    return json({ Items: [], TotalRecordCount: 0 });
  }
  if (path === "/Years") return json({ Items: [], TotalRecordCount: 0 });
  if (path === "/Library/VirtualFolders") {
    const rows = await env.DB.prepare("SELECT * FROM libraries ORDER BY id").all();
    return json(rows.results.map((row: any) => ({
      Name: row.name,
      Id: `lib_${row.id}`,
      CollectionType: row.type,
      ItemId: `lib_${row.id}`,
      Path: row.path,
    })));
  }
  if (path === "/ScheduledTasks") return json([]);
  if (path.startsWith("/Users/") && path.endsWith("/Views")) {
    const id = segments[1];
    return embyViews(env, id);
  }
  if (path.startsWith("/Users/") && path.endsWith("/Items/Latest")) {
    return embyLatest(env, new URL(request.url));
  }
  if (path.startsWith("/Users/") && path.endsWith("/Items/Resume")) {
    return json({ Items: [], TotalRecordCount: 0 });
  }
  if (path.startsWith("/Users/") && segments.length === 2) return embyUser(env, segments[1]);
  if (path.startsWith("/Users/") && segments.length >= 3 && segments[2] === "Items") {
    return embyItems(env, new URL(request.url), user);
  }

  if (path === "/Items" || path === "/Items/Root") {
    return embyItems(env, new URL(request.url), user);
  }
  if (segments[0] === "Items" && segments.length === 4 && segments[2] === "Images") {
    return embyImage(env, segments[1], segments[3]);
  }
  if (segments[0] === "Items" && segments.length === 3 && segments[2] === "PlaybackInfo") {
    const token = tokenFromRequest(request) || "";
    return embyPlaybackInfo(env, segments[1], token);
  }
  if (segments[0] === "Items" && segments.length === 2) return embyItemDetail(env, segments[1]);

  if (segments[0] === "Shows" && segments[2] === "Seasons") return embySeasons(env, segments[1]);
  if (segments[0] === "Shows" && segments[2] === "Episodes") {
    return embyEpisodes(env, segments[1], new URL(request.url));
  }

  if ((segments[0] === "Videos" || segments[0] === "videos") && segments.length >= 3) {
    const action = segments[2];
    const direct = action === "stream" || action === "original.mp4" || action === "original.strm"
      || action.startsWith("stream.") || action.startsWith("original.");
    const withSource = segments.length >= 4 && (segments[3] === "stream" || segments[3].startsWith("stream."));
    if (direct || withSource) return embyStream(request, env, segments[1]);
  }

  return json({ error: "not found" }, 404);
}

async function handleWeb(request: Request, env: Env, segments: string[]): Promise<Response> {
  const method = request.method;
  const path = `/${segments.join("/")}`;
  if (path === "/api/login" && method === "POST") return webLogin(request, env);
  if (path === "/api/config") return webConfig(request, env);
  if (path === "/api/settings" && method === "POST") return webSaveSettings(request, env);
  if (path === "/api/user/password" && method === "POST") return webChangePassword(request, env);
  if (path === "/api/alist/list") return webAlistList(request, env);
  if (path === "/api/libraries") return webLibraries(request, env);
  if (segments[0] === "api" && segments[1] === "libraries" && segments[2] && segments[3] === "scan" && method === "POST") {
    return webScan(request, env, Number(segments[2]));
  }
  if (segments[0] === "api" && segments[1] === "libraries" && segments[2] && method === "DELETE") {
    return webDeleteLibrary(request, env, Number(segments[2]));
  }
  if (segments[0] === "api" && segments[1] === "scan" && segments[2] && segments[3] === "step" && method === "POST") {
    return webScanStep(request, env, Number(segments[2]));
  }
  if (segments[0] === "api" && segments[1] === "scan" && segments[2]) {
    return webScanStatus(request, env, Number(segments[2]));
  }
  if (path === "/api/debug") return webDebug(request, env);
  if (path === "/api/items") return webItems(request, env);
  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] === "api") return handleWeb(request, env, segments);
    if (segments[0] === "emby") return handleEmby(request, env, segments.slice(1));
    if (["System", "Users", "Items", "Videos", "videos", "Shows", "Sessions", "Genres", "Tags", "Years", "Studios", "OfficialRatings", "Library", "Auth", "DisplayPreferences", "ScheduledTasks"].includes(segments[0])) {
      return handleEmby(request, env, segments);
    }
    return env.ASSETS.fetch(request);
  },
};
