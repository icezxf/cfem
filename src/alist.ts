import type { Env } from "./types";

export interface AlistEntry {
  name: string;
  is_dir: boolean;
  size: number;
  modified?: string;
}

interface AlistResponse<T> {
  code: number;
  message?: string;
  data?: T;
}

export class Alist {
  constructor(private base: string, private token: string) {}

  static fromEnv(env: Env): Alist {
    if (!env.ALIST_URL || !env.ALIST_TOKEN) {
      throw new Error("ALIST_URL / ALIST_TOKEN 未配置");
    }
    return new Alist(env.ALIST_URL.replace(/\/+$/, ""), env.ALIST_TOKEN);
  }

  private headers(): HeadersInit {
    return {
      Authorization: this.token,
      "Content-Type": "application/json",
    };
  }

  private absolute(raw: string): string {
    if (/^https?:\/\//i.test(raw)) return raw;
    return `${this.base}${raw.startsWith("/") ? "" : "/"}${raw}`;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.base}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`AList ${path} 返回 HTTP ${response.status}`);
    }
    const payload = (await response.json()) as AlistResponse<T>;
    if (payload.code !== 200 || !payload.data) {
      throw new Error(`AList ${path} 失败: ${payload.message || payload.code}`);
    }
    return payload.data;
  }

  async list(path: string, page = 1, perPage = 200): Promise<{ entries: AlistEntry[]; total: number }> {
    const data = await this.post<{ content: AlistEntry[]; total: number }>("/api/fs/list", {
      path,
      password: "",
      page,
      per_page: perPage,
      refresh: false,
    });
    return { entries: data.content || [], total: data.total || 0 };
  }

  async stat(path: string): Promise<{ raw_url: string; size: number; is_dir: boolean; name: string }> {
    return this.post("/api/fs/get", { path, password: "" });
  }

  async rawUrl(path: string): Promise<string> {
    const data = await this.stat(path);
    return this.absolute(data.raw_url);
  }

  async readText(path: string): Promise<string> {
    const url = await this.rawUrl(path);
    const response = await fetch(url, { headers: { Authorization: this.token } });
    if (!response.ok) throw new Error(`读取 ${path} 失败: HTTP ${response.status}`);
    return response.text();
  }

  async readBinary(path: string): Promise<Response> {
    const url = await this.rawUrl(path);
    return fetch(url, { headers: { Authorization: this.token } });
  }
}
