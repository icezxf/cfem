# CFEM

Cloudflare Worker + D1 + AList 的 Emby 兼容媒体服务器。

目标：不租 VPS，用 Cloudflare 免费额度做一个“能连 Emby 客户端”的精简服务：

- AList 里放 `.strm`（和 NFO/海报），视频本体留在网盘；
- Worker 负责 Emby API、登录、列表、302 播放；
- D1 存媒体库/条目/Token/会话；
- Web 页面负责配置媒体库、浏览 AList 目录、扫描。

## 架构

```text
Emby 客户端 / 浏览器
        │
        ▼
Cloudflare Worker（src/index.ts）
  ├─ Emby API       /emby/*
  ├─ Web API        /api/*
  ├─ D1            媒体库、条目、Token、会话
  └─ AList API      /api/fs/list、/api/fs/get、raw_url
        │
        ▼
     AList（公网可达）
        │
        ▼
     网盘 / STRM 文件
```

播放链路和 rust-em 一样：读 `.strm` → 解析真实直链 → 返回 302，视频不经过 Worker。

## 功能

- 管理员登录、媒体库增删、AList 目录浏览
- 扫描 AList 目录，识别 `.strm`
- 电影 / 剧集（按 `SxxExx` 解析 Series、Season、Episode）
- Emby：`Users/AuthenticateByName`、`Users/Public`、`Users/{id}`、`Views`
- Emby：`Items`、`Items/{id}`、`Shows/{id}/Seasons`、`Shows/{id}/Episodes`
- Emby：`Items/{id}/Images/{type}`、`PlaybackInfo`、`Videos/{id}/stream`（302）
- Emby：`Sessions`、`Playing`、`Progress`、`Stopped`、`Logout`
- Web 端：登录、添加媒体库、AList 目录选择、扫描进度、海报墙、详情、播放

## 限制

这是精简实现，不是完整 Emby：

- **没有 MediaInfo 探测/转码**：时长/编码只能来自 NFO，纯 STRM 可能没有时长。
- **没有封面拼接**：只使用 AList 目录里的 `poster.jpg`/`fanart.jpg`。
- **扫描是前端分批驱动**：Web 页面会循环调用 `/api/scan/{id}/step`；没有 Queue/DO 编排。
- **单管理员**：`users` 表只内置 admin，普通用户/库权限未实现。
- **海报是 Worker 代理**：图片请求会经过 Worker；库很大时建议改 R2 或直链。
- **远程控制未实现**：`SupportsRemoteControl` 为 false。

## 部署

### 1. 准备

- Node.js 18+
- Cloudflare 账号（免费计划即可）
- 一个公网可访问的 AList，以及 AList Token
- AList 里准备好 `.strm` 文件（内容是一行网盘直链）

### 2. 安装依赖

```bash
npm install
npx wrangler login
```

### 3. 创建 D1

```bash
npx wrangler d1 create cfem
```

把输出的 `database_id` 填到 `wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "cfem"
database_id = "这里填 database_id"
```

初始化表结构：

```bash
npx wrangler d1 execute cfem --remote --file=./schema.sql
```

### 4. 配置 Secrets

```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put ALIST_URL
npx wrangler secret put ALIST_TOKEN
```

- `ADMIN_PASSWORD`：Web/Emby 管理员密码，首次启动时自动创建 `admin`。
- `ALIST_URL`：例如 `https://alist.example.com`，不要带结尾斜杠。
- `ALIST_TOKEN`：AList 后台生成的 Token。请求头会以 `Authorization: <token>` 发送。

> AList Token 权限很大，只放在 Worker Secret 里，不要写进前端或仓库。

### 4.1 用 Cloudflare API Token 代替浏览器登录

如果不想用 `wrangler login` 的 OAuth，可以在 CI/脚本里用 API Token：

1. Cloudflare Dashboard → **My Profile → API Tokens → Create Token → Custom token**
2. 权限建议：

| 权限 | 用途 |
|---|---|
| Account → **Workers Scripts → Edit** | 部署 Worker、写 Secret |
| Account → **D1 → Edit** | 创建 D1、执行 schema |
| Account → **Account Settings → Read** | `wrangler whoami` / 读取账号（可选） |
| Zone → **Workers Routes → Edit** | 绑定自定义域名/路由时 |
| Zone → **Zone → Read** | 自定义域名/路由时 |
| Account → **Workers R2 Storage → Edit** | 以后用 R2 时再加，当前不需要 |

3. Account resources 选你的账号；Zone resources 选目标域名或 All zones。
4. 设置环境变量并部署：

```bash
export CLOUDFLARE_API_TOKEN="你的 token"
export CLOUDFLARE_ACCOUNT_ID="你的 account id"

npx wrangler whoami
npx wrangler d1 create cfem
npx wrangler d1 execute cfem --remote --file=./schema.sql
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put ALIST_URL
npx wrangler secret put ALIST_TOKEN
npx wrangler deploy
```

注意：

- **第一次部署会创建新 Worker**。Cloudflare 要求产品级 **Workers Admin** 才能创建 Worker；只有 `Editor` 时可能报权限错误。可以先用 Dashboard 手动创建一个同名 Worker，或把 token 的 Workers 权限设为 Admin。
- Worker 已存在后，日常 `wrangler deploy` 只需要 `Workers Scripts: Edit`。
- `wrangler d1 create` / `d1 execute --remote` 需要 D1 Edit。
- `wrangler secret put` 需要 Workers Scripts Edit。
- Token 不要提交到仓库；本地放 `.dev.vars` 之外，CI 用 Secret 注入。
- 不想用 token 时可以继续用 `npx wrangler login`，两者二选一。

### 5. 部署

```bash
npm run deploy
```

Wrangler 会输出 Worker URL，例如：

```text
https://cfem.<your-subdomain>.workers.dev
```

### 6. 首次配置

1. 打开 Worker URL；
2. 用 `admin` + `ADMIN_PASSWORD` 登录；
3. 填媒体库名称、类型、AList 路径（可点“浏览”选择目录）；
4. 点“添加”，再点“扫描”，等待进度完成；
5. 到 Emby 客户端添加服务器：
   - 地址：`https://cfem.<your-subdomain>.workers.dev`
   - 用户名：`admin`
   - 密码：`ADMIN_PASSWORD`

Emby 客户端会访问 `/emby/...`，Worker 同时兼容根路径 `/Users/...`、`/Items/...`。

## 本地开发

```bash
npx wrangler d1 execute cfem --local --file=./schema.sql
npm run dev
```

`wrangler dev` 默认使用本地 D1；Secrets 可以在 `.dev.vars` 里配置（不要提交）：

```ini
ADMIN_PASSWORD=admin
ALIST_URL=https://alist.example.com
ALIST_TOKEN=your-token
```

## API 概览

Web：

```text
POST /api/login
GET  /api/config
GET  /api/alist/list?path=/
GET  /api/libraries
POST /api/libraries          { name, type, path }
DELETE /api/libraries/:id
POST /api/libraries/:id/scan
POST /api/scan/:id/step
GET  /api/scan/:id
GET  /api/items?library_id=&limit=&offset=
```

Emby：

```text
POST /emby/Users/AuthenticateByName
GET  /emby/Users/Public
GET  /emby/Users/:id
GET  /emby/Users/:id/Views
GET  /emby/Items
GET  /emby/Items/:id
GET  /emby/Items/:id/Images/:type
GET  /emby/Items/:id/PlaybackInfo
GET  /emby/Shows/:id/Seasons
GET  /emby/Shows/:id/Episodes
GET  /emby/Videos/:id/stream
GET  /emby/Sessions
POST /emby/Sessions/Playing
POST /emby/Sessions/Playing/Progress
POST /emby/Sessions/Playing/Stopped
POST /emby/Sessions/Logout
```

认证支持：

- `Authorization: Bearer <token>`
- `X-Emby-Token: <token>`
- `Authorization: MediaBrowser ..., Token="<token>"`
- `?api_key=<token>` / `?token=<token>`

## 免费额度注意

- Workers Free：10 万请求/天、每次 HTTP 请求 10ms CPU、128MB、50 子请求。
- D1 Free：5GB、500 万行读/天、10 万行写/天。
- AList 每个目录/文件一次 API 调用；大库扫描请分批，避免一次请求处理太多文件。
- 图片走 Worker 会增加请求数；大库建议后续改为 R2 直出。
- 超过 10ms CPU 会返回 1102；列表页已限制每页 60 条。

## 安全

- 首次部署后立即改 `ADMIN_PASSWORD`，不要用默认值。
- AList Token 放在 Secret，不要提交 `.dev.vars`。
- 这是个人媒体服务，不要公开分享 Worker 地址和 AList Token。
- 生产环境建议加 Cloudflare Access 或自定义域名 + 防火墙规则。

## 后续可做

- R2 缓存海报/封面，Worker 只返回 302 到 R2
- Queue + Durable Object 编排扫描，支持断点续扫
- NFO 元数据解析（标题、简介、年份、类型）
- 普通用户/媒体库权限
- Emby 远程控制 WebSocket
