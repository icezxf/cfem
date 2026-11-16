import type { Env } from "./types";

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

export function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomId(): string {
  return crypto.randomUUID();
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function isoDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

export function tokenFromRequest(request: Request): string | null {
  const auth = request.headers.get("Authorization") || "";
  const bearer = auth.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1].trim();
  const mediaBrowser = auth.match(/Token="([^"]+)"/i);
  if (mediaBrowser) return mediaBrowser[1];
  const emby = request.headers.get("X-Emby-Token");
  if (emby) return emby;
  const embyAuth = request.headers.get("X-Emby-Authorization") || "";
  const embyToken = embyAuth.match(/Token="([^"]+)"/i);
  if (embyToken) return embyToken[1];
  const url = new URL(request.url);
  for (const key of ["api_key", "apikey", "token", "X-Emby-Token", "x-emby-token"]) {
    const value = url.searchParams.get(key);
    if (value) return value;
  }
  return null;
}

export function intParam(url: URL, key: string, fallback: number): number {
  const value = Number(url.searchParams.get(key));
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

export function boolParam(url: URL, key: string): boolean {
  return url.searchParams.get(key) === "true";
}

export function adminRequired(env: Env): Response | null {
  if (!env.ADMIN_PASSWORD) {
    return json({ error: "ADMIN_PASSWORD 未配置，请先 wrangler secret put ADMIN_PASSWORD" }, 500);
  }
  return null;
}
