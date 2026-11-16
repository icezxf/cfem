export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ALIST_URL?: string;
  ALIST_TOKEN?: string;
  ADMIN_PASSWORD?: string;
}

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  is_admin: number;
}

export interface LibraryRow {
  id: number;
  name: string;
  type: string;
  path: string;
}

export interface ItemRow {
  id: number;
  library_id: number;
  title: string;
  type: string;
  year: string | null;
  plot: string | null;
  poster: string | null;
  fanart: string | null;
  runtime: number;
  genres: string | null;
  tags: string | null;
  strm_path: string;
  strm_url: string | null;
  size: number;
  mtime: number;
  series_id: number | null;
  season_number: number | null;
  episode_number: number | null;
  parent_id: number | null;
}

export interface SessionRow {
  id: string;
  user_id: number;
  user_name: string;
  client: string | null;
  device: string | null;
  last_activity: number;
  now_playing: number | null;
  position_ticks: number;
  is_paused: number;
}
