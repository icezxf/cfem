const state = {
  token: localStorage.getItem("cfem_token") || "",
  libraries: [],
  libraryId: 0,
  offset: 0,
  total: 0,
  items: [],
};

const $ = (id) => document.getElementById(id);
const hidden = (el, value = true) => el.classList.toggle("hidden", value);

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (options.body) headers["Content-Type"] = "application/json";
  const response = await fetch(path, { ...options, headers });
  if (response.status === 401) {
    logout();
    throw new Error("登录已过期");
  }
  return response;
}

async function login() {
  const response = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: $("username").value, password: $("password").value }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "登录失败");
  state.token = data.token;
  localStorage.setItem("cfem_token", data.token);
  await showApp();
}

function logout() {
  state.token = "";
  localStorage.removeItem("cfem_token");
  hidden($("app"), true);
  hidden($("login"), false);
}

async function showApp() {
  hidden($("login"), true);
  hidden($("app"), false);
  try {
    const config = await (await api("/api/config")).json();
    $("alist-state").textContent = config.alistConfigured ? `AList: ${config.alistUrl}` : "AList 未配置";
    await loadLibraries();
  } catch (e) {
    console.error(e);
  }
}

async function loadLibraries() {
  const data = await (await api("/api/libraries")).json();
  state.libraries = data.libraries || [];
  const box = $("libraries");
  box.innerHTML = state.libraries.map((lib) => {
    const active = lib.id === state.libraryId ? " active" : "";
    return `<div class="chip${active}" data-id="${lib.id}">${escapeHtml(lib.name)}</div>`;
  }).join("");
  box.querySelectorAll(".chip").forEach((el) => {
    el.onclick = () => {
      state.libraryId = Number(el.dataset.id);
      loadLibraries();
      loadItems(true);
    };
  });
  if (!state.libraryId && state.libraries.length) {
    state.libraryId = state.libraries[0].id;
    loadLibraries();
    loadItems(true);
  }
}

async function addLibrary() {
  const name = $("lib-name").value.trim();
  const path = $("lib-path").value.trim();
  const type = $("lib-type").value;
  if (!name || !path) return;
  const response = await api("/api/libraries", { method: "POST", body: JSON.stringify({ name, type, path }) });
  if (!response.ok) {
    alert("添加失败");
    return;
  }
  $("lib-name").value = "";
  $("lib-path").value = "";
  await loadLibraries();
}

async function scanLibrary() {
  if (!state.libraryId) return;
  $("scan-state").textContent = "正在启动扫描...";
  const start = await (await api(`/api/libraries/${state.libraryId}/scan`, { method: "POST" })).json();
  if (!start.id) {
    $("scan-state").textContent = start.error || "启动失败";
    return;
  }
  for (;;) {
    const job = await (await api(`/api/scan/${start.id}/step`, { method: "POST" })).json();
    $("scan-state").textContent = `扫描中：已处理 ${job.scanned || 0} 个文件${job.status === "done" ? "（完成）" : ""}`;
    if (job.status === "done" || job.status === "error") {
      if (job.error) $("scan-state").textContent = `扫描失败：${job.error}`;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  await loadItems(true);
}

async function loadItems(reset = true) {
  if (reset) {
    state.offset = 0;
    state.items = [];
    $("items").innerHTML = "";
  }
  const data = await (await api(`/api/items?library_id=${state.libraryId}&limit=60&offset=${state.offset}`)).json();
  state.total = data.total || 0;
  state.items = state.items.concat(data.items || []);
  state.offset = state.items.length;
  renderItems();
}

function renderItems() {
  const grid = $("items");
  grid.innerHTML = state.items.map((item) => {
    const poster = item.poster
      ? `<img src="/emby/Items/${item.id}/Images/Primary?api_key=${encodeURIComponent(state.token)}" loading="lazy">`
      : `<div class="poster-fallback">无封面</div>`;
    const sub = item.type === "Episode" ? `S${item.season_number || 1}E${item.episode_number || 1}` : (item.year || item.type);
    return `<div class="card" data-id="${item.id}">
      ${poster}
      <div class="name">${escapeHtml(item.title)}</div>
      <div class="sub">${escapeHtml(String(sub))}</div>
    </div>`;
  }).join("");
  grid.querySelectorAll(".card").forEach((el) => {
    el.onclick = () => openItem(el.dataset.id);
  });
  hidden($("load-more"), state.offset >= state.total);
}

async function openItem(id) {
  const item = await (await api(`/emby/Items/${id}?api_key=${encodeURIComponent(state.token)}`)).json();
  const canPlay = item.Type === "Movie" || item.Type === "Episode";
  let html = `<h2>${escapeHtml(item.Name || "")}</h2>
    <p class="hint">${escapeHtml(item.Type || "")} ${item.ProductionYear || ""}</p>
    <p>${escapeHtml(item.Overview || "暂无简介")}</p>
    <div class="detail-actions">
      ${canPlay ? `<button id="play-btn">播放</button>` : ""}
      <button class="ghost" id="detail-close">关闭</button>
    </div>`;
  if (item.Type === "Series") {
    const seasons = await (await api(`/emby/Shows/${id}/Seasons?api_key=${encodeURIComponent(state.token)}`)).json();
    html += `<h3>季</h3><div class="chips">${(seasons.Items || []).map((s) =>
      `<div class="chip" data-season="${s.Id}">${escapeHtml(s.Name)}</div>`).join("")}</div><div id="episodes"></div>`;
  }
  if (item.Type === "Season") {
    const episodes = await (await api(`/emby/Shows/${item.SeriesId}/Episodes?SeasonId=${id}&api_key=${encodeURIComponent(state.token)}`)).json();
    html += `<h3>集</h3>` + (episodes.Items || []).map((e) =>
      `<div class="dir" data-episode="${e.Id}">${escapeHtml(e.Name)}</div>`).join("");
  }
  $("modal-body").innerHTML = html;
  hidden($("modal"), false);
  $("detail-close").onclick = () => hidden($("modal"), true);
  const playBtn = $("play-btn");
  if (playBtn) playBtn.onclick = () => play(item.Id);
  document.querySelectorAll("[data-episode]").forEach((el) => {
    el.onclick = () => play(el.dataset.episode);
  });
  document.querySelectorAll("[data-season]").forEach((el) => {
    el.onclick = () => openItem(el.dataset.season);
  });
}

function play(id) {
  $("modal-body").innerHTML = `<h2>播放</h2><video controls autoplay src="/emby/Videos/${id}/stream?api_key=${encodeURIComponent(state.token)}"></video>`;
  hidden($("modal"), false);
}

async function browse(path = "/") {
  const data = await (await api(`/api/alist/list?path=${encodeURIComponent(path)}`)).json();
  if (data.error) {
    alert(data.error);
    return;
  }
  const dirs = (data.entries || []).filter((e) => e.is_dir);
  $("modal-body").innerHTML = `<h2>选择 AList 目录</h2>
    <p class="hint">当前：${escapeHtml(data.path)}</p>
    <div class="detail-actions">
      <button class="ghost" id="up">上一级</button>
      <button id="pick">选择当前目录</button>
    </div>
    <div>${dirs.map((d) => `<div class="dir" data-path="${escapeHtml(d.name)}">📁 ${escapeHtml(d.name)}</div>`).join("") || '<p class="hint">没有子目录</p>'}</div>`;
  hidden($("modal"), false);
  $("modal-close").onclick = () => hidden($("modal"), true);
  $("pick").onclick = () => {
    $("lib-path").value = data.path;
    hidden($("modal"), true);
  };
  $("up").onclick = () => browse(path.split("/").slice(0, -1).join("/") || "/");
  document.querySelectorAll(".dir[data-path]").forEach((el) => {
    el.onclick = () => browse(`${path.replace(/\/+$/, "")}/${el.dataset.path}`);
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

$("login-btn").onclick = () => login().catch((e) => { $("login-error").textContent = e.message; });
$("logout").onclick = logout;
$("add-lib").onclick = addLibrary;
$("scan-btn").onclick = scanLibrary;
$("browse-btn").onclick = () => browse("/");
$("load-more").onclick = () => loadItems(false);
$("modal-close").onclick = () => hidden($("modal"), true);

if (state.token) showApp();
