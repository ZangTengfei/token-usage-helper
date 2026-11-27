import { dailyChart } from "./trends.mjs";
import { mountUpdater } from "./updater.mjs";
import { DEFAULT_CLIENTS } from "./source-catalog.mjs";
import { safeAvatarUrl } from "./profile.mjs";
import { CommunityBoard } from "./leaderboard.mjs";
import { enhanceSelect } from "./select.mjs";
import {
  dashboard,
  heatCells,
  CLIENTS as allClients,
  FIELDS,
  todayISO,
  syncStatus,
} from "./analytics.mjs";
const CLIENTS = Object.fromEntries(Object.entries(allClients).filter(
  ([id]) => id !== "cursor" || window.clubUsage.importCursor,
));
const $ = (id) => document.getElementById(id);
const format = (n) =>
  new Intl.NumberFormat("zh-CN", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
const exact = (n) => new Intl.NumberFormat("zh-CN").format(n);
const percent = (n) =>
  new Intl.NumberFormat("zh-CN", {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(n);
const labels = {
  input: "输入（不含缓存）",
  output: "输出（不含推理）",
  cache_read: "缓存读取",
  cache_write: "缓存写入",
  reasoning: "推理",
};
const when = (value) =>
  value
    ? new Date(value).toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "尚未完成";
let current = null,
  view = "overview",
  selected = todayISO(),
  report = null,
  signature = "";
let stackDimension = "model";
let boardPeriod = "7d";
let selectControls = [];
const board = new CommunityBoard((period) => window.clubUsage.action("leaderboard", period));
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
const toolTones = {
  codex: "green",
  claude: "orange",
  opencode: "blue",
  gemini: "purple",
  kimi: "neutral",
  qwen: "purple",
  openclaw: "green",
  dsh: "blue",
  cline: "blue",
  roocode: "purple",
  kilocode: "orange",
  copilot: "green",
  hermes: "blue",
  pi: "orange",
  goose: "purple",
  droid: "green",
  workbuddy: "blue",
  zcode: "blue",
  teleagent: "purple",
  qoder: "green",
  kiro: "purple",
};
function toolMark(client) {
  const mark = element(
    "span",
    undefined,
    `tool-mark tone-${toolTones[client] || "neutral"}`,
  );
  mark.setAttribute("aria-hidden", "true");
  const img = element("img");
  img.src = `icons/${client}.webp`;
  img.alt = "";
  img.width = 32;
  img.height = 32;
  img.decoding = "async";
  mark.append(img);
  return mark;
}
function renderAvatar(id, state) {
  const host = $(id),
    src = state.linked ? safeAvatarUrl(state.avatarUrl) : "",
    initial = state.linked ? Array.from(state.nickname || "社区成员")[0] : "本";
  if (host.dataset.src === src && host.dataset.initial === initial) return;
  host.dataset.src = src;
  host.dataset.initial = initial;
  host.replaceChildren();
  const fallback = element("span", initial);
  host.append(fallback);
  if (src) {
    const img = element("img");
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.decoding = "async";
    img.onload = () => {
      fallback.hidden = true;
    };
    img.onerror = () => {
      img.remove();
      fallback.hidden = false;
    };
    img.src = src;
    host.append(img);
  }
}
const icons = {
  refresh: [
    "M20 7v5h-5",
    "M4 17v-5h5",
    "M6.1 7a7 7 0 0 1 11.6-2L20 8",
    "M4 16l2.3 3A7 7 0 0 0 18 17",
  ],
  chart: ["M5 20v-7h3v7", "M11 20V4h3v16", "M17 20v-11h3v11"],
  folder: ["M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9H3Z"],
  power: ["M12 3v9", "M7 5a9 9 0 1 0 10 0"],
  info: ["M12 11v6", "M12 7h.01"],
  settings: [
    "M14 6a4 4 0 0 0-5 5L3 17a2 2 0 0 0 4 4l6-6a4 4 0 0 0 5-5l-3 3-4-4Z",
  ],
};
for (const holder of document.querySelectorAll("[data-icon]")) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.8",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  }))
    svg.setAttribute(key, value);
  if (holder.dataset.icon === "info") {
    const c = document.createElementNS(svg.namespaceURI, "circle");
    for (const [k, v] of Object.entries({ cx: 12, cy: 12, r: 9 }))
      c.setAttribute(k, v);
    svg.append(c);
  }
  for (const d of icons[holder.dataset.icon] || []) {
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  holder.append(svg);
}
function list(target, rows, names = {}) {
  target.replaceChildren();
  if (!rows.length) {
    target.append(element("p", "当前筛选范围未发现记录。", "empty"));
    return;
  }
  for (const row of rows) {
    const wrapper = element("div", undefined, "distribution"),
      line = element("div", undefined, "line");
    line.append(
      element("span", names[row.name] || row.name),
      element("span", `${format(row.tokens)} · ${percent(row.share)}`),
    );
    line.title = `${names[row.name] || row.name}：${exact(row.tokens)} Token`;
    const track = element("div", undefined, "track"),
      fill = element("div", undefined, "fill");
    fill.style.width = `${row.share * 100}%`;
    track.append(fill);
    const body = element("div", undefined, "distribution-body");
    body.append(line, track);
    wrapper.append(toolMark(row.name), body);
    target.append(wrapper);
  }
}
function selectDay(date, focus = false) {
  selected = date;
  for (const cell of $("heatmap").querySelectorAll("button")) {
    const active = cell.dataset.date === date;
    cell.setAttribute("aria-pressed", String(active));
    cell.tabIndex = active ? 0 : -1;
    if (active && focus) cell.focus();
  }
  renderDay();
}
function renderDay() {
  const d = report?.days.find((x) => x.date === selected);
  const panel = $("day-detail");
  panel.replaceChildren();
  if (!d) return;
  panel.append(element("h3", `${d.date.slice(5).replace("-", "月")}日`));
  if (!d.known) {
    panel.append(
      element("p", "未发现记录", "day-total"),
      element(
        "p",
        "可能未使用、日志缺失或尚未读取；不将其当成零用量。",
        "hint",
      ),
    );
    return;
  }
  const number = element("p", format(d.total), "day-total");
  number.title = `${exact(d.total)} Token`;
  panel.append(
    number,
    element(
      "p",
      report.includeCache ? "Token · 包含缓存" : "Token · 不含缓存",
      "muted",
    ),
  );
  for (const r of d.tools) {
    const line = element("div", undefined, "day-line");
    line.append(
      element("span", CLIENTS[r.name]),
      element("b", format(r.tokens)),
    );
    panel.append(line);
  }
  const model = d.models[0];
  if (model)
    panel.append(element("p", `最常用模型：${model.name}`, "day-model"));
}
function renderCharts(force = false) {
  if (!current) return;
  const key = JSON.stringify([
    current.snapshot?.captured_at,
    current.lastCollectedAt,
    !!current.summary,
    $("client").value,
    $("range").value,
    $("cache").checked,
    todayISO(),
  ]);
  if (!force && key === signature) return;
  signature = key;
  report = dashboard(current.snapshot, {
    client: $("client").value,
    range: Number($("range").value),
    includeCache: $("cache").checked,
  });
  for (const name of ["today", "week", "month"]) {
    const metric = report.metrics[name];
    $(name).textContent = metric.days ? format(metric.total) : "—";
    $(name).title = metric.days ? `${exact(metric.total)} Token` : "";
    $(name + "-note").textContent = !current.snapshot
      ? "等待本机读取"
      : name === "today"
        ? metric.days
          ? "按本机可用记录统计"
          : "今日未发现记录"
        : `${metric.days} / ${metric.length} 天有记录`;
  }
  $("legacy").hidden = Boolean(current.snapshot) || !current.summary;
  $("heat-subtitle").textContent =
    `${report.start} — ${report.today} · 北京时间`;
  $("active-days").textContent =
    `${report.days.filter((d) => d.known && d.total > 0).length} 天有用量`;
  if (!report.days.some((d) => d.date === selected)) selected = report.today;
  const cells = heatCells(report.days),
    weeks = cells.length / 7,
    grid = $("heatmap"),
    months = $("months");
  grid.replaceChildren();
  months.replaceChildren();
  const mode =
    report.range === 7 ? "bars" : report.range === 30 ? "month" : "heatmap";
  grid.dataset.mode = mode;
  document.querySelector(".calendar-section").dataset.mode = mode;
  months.hidden = mode !== "heatmap";
  document.querySelector(".weekdays").hidden = mode === "bars";
  document.querySelector(".legend").hidden = mode === "bars";
  document.querySelector(".calendar-section > .hint").textContent =
    mode === "bars"
      ? "点击或使用左右方向键查看每日详情。"
      : "颜色按当前范围相对用量分档；点击或用方向键选日。";
  grid.style.gridTemplateColumns = `repeat(${mode === "heatmap" ? weeks : 7},minmax(0,1fr))`;
  grid.style.maxWidth = "none";
  months.style.gridTemplateColumns = `repeat(${weeks},minmax(0,1fr))`;
  months.style.maxWidth = "none";
  const maxDay = Math.max(1, ...report.days.map((d) => d.total));
  let month = "";
  for (let w = 0; w < weeks; w++) {
    const first = cells.slice(w * 7, w * 7 + 7).find(Boolean);
    const next = first?.date.slice(0, 7) || "";
    months.append(
      element("span", next !== month ? `${Number(next.slice(5))}月` : ""),
    );
    month = next;
  }
  for (const d of mode === "bars" ? report.days : cells) {
    if (!d) {
      const blank = element("span", undefined, "heat-blank");
      blank.setAttribute("aria-hidden", "true");
      grid.append(blank);
      continue;
    }
    const cell = element(
      "button",
      undefined,
      mode === "bars"
        ? "daily-column"
        : d.level === -1
          ? "unknown"
          : d.level === 0
            ? "zero"
            : `level-${d.level}`,
    );
    if (mode === "bars") {
      const stack = element("span", undefined, "daily-stack"),
        bar = element(
          "span",
          undefined,
          `daily-fill${d.known ? "" : " daily-unknown"}${d.known && !d.total ? " daily-zero" : ""}`,
        );
      bar.style.height = d.known ? `${(d.total / maxDay) * 100}%` : "5px";
      stack.append(bar);
      cell.append(
        element("span", d.known ? format(d.total) : "未发现", "daily-value"),
        stack,
        element(
          "span",
          `${Number(d.date.slice(5, 7))}/${Number(d.date.slice(8))}`,
          "daily-date",
        ),
      );
    } else if (mode === "month") {
      cell.textContent = String(Number(d.date.slice(8)));
    }
    cell.type = "button";
    cell.dataset.date = d.date;
    const description = `${d.date}，${d.known ? exact(d.total) + " Token" : "未发现记录"}`;
    cell.title = description;
    cell.setAttribute("aria-label", description);
    cell.setAttribute("aria-pressed", String(d.date === selected));
    cell.tabIndex = d.date === selected ? 0 : -1;
    cell.onclick = () => selectDay(d.date);
    cell.onfocus = () => selectDay(d.date);
    cell.onkeydown = (e) => {
      const index = report.days.findIndex((x) => x.date === d.date),
        delta = (
          mode === "heatmap"
            ? { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 }
            : {
                ArrowUp: mode === "month" ? -7 : -1,
                ArrowDown: mode === "month" ? 7 : 1,
                ArrowLeft: -1,
                ArrowRight: 1,
              }
        )[e.key];
      let target = delta === undefined ? null : index + delta;
      if (e.key === "Home") target = 0;
      if (e.key === "End") target = report.days.length - 1;
      if (target !== null) {
        e.preventDefault();
        selectDay(
          report.days[Math.max(0, Math.min(report.days.length - 1, target))]
            .date,
          true,
        );
      }
    };
    grid.append(cell);
  }
  renderDay();
  dailyChart(report, stackDimension, selectDay);
  list($("tool-summary"), report.tools, CLIENTS);
  list($("tools"), report.tools, CLIENTS);
  $("cache-ratio").textContent =
    report.cacheRatio === null ? "—" : percent(report.cacheRatio);
  $("counting-note").textContent = report.includeCache
    ? "当前总量 = 输入 + 输出 + 推理 + 缓存读取 + 缓存写入。各项互不重复。"
    : "当前总量 = 输入 + 输出 + 推理。缓存占比仍按原始记录计算。";
  $("tools-subtitle").textContent =
    `近 ${report.range} 天 · ${CLIENTS[report.client] || "全部工具"} · ${report.includeCache ? "包含缓存" : "不含缓存"}`;
  if (report.unavailable?.length) $("counting-note").textContent += " 部分调用未提供完整分项，仅汇总已记录的Token。";
  $("range-total").textContent = report.recordCount
    ? format(report.total) + " Token"
    : "未发现记录";
  $("composition").replaceChildren();
  $("composition-legend").replaceChildren();
  const compositionTotal = FIELDS.reduce(
    (sum, f) => sum + report.buckets[f],
    0,
  );
  $("composition").setAttribute(
    "aria-label",
    compositionTotal
      ? FIELDS.map(
          (f) =>
            `${labels[f]} ${percent(report.buckets[f] / compositionTotal)}`,
        ).join("，")
      : "未发现构成记录",
  );
  for (const f of FIELDS) {
    if (!compositionTotal || !report.buckets[f]) continue;
    const segment = element("span", undefined, `segment segment-${f}`);
    segment.style.width = `${(report.buckets[f] / compositionTotal) * 100}%`;
    segment.title = `${labels[f]}：${exact(report.buckets[f])} Token`;
    $("composition").append(segment);
    const legend = element("span", undefined, "composition-item");
    legend.append(
      element("i", undefined, `segment-${f}`),
      element("span", labels[f]),
    );
    const value = element(
      "small",
      percent(report.buckets[f] / compositionTotal),
    );
    legend.append(value);
    $("composition-legend").append(legend);
  }
  $("tools-composition").replaceChildren();
  const visibleFields = FIELDS.filter(
    (f) => report.includeCache || !f.startsWith("cache_"),
  );
  const visibleTotal = visibleFields.reduce(
    (sum, f) => sum + report.buckets[f],
    0,
  );
  $("tools-composition").setAttribute(
    "aria-label",
    visibleTotal
      ? visibleFields
          .map(
            (f) => `${labels[f]} ${percent(report.buckets[f] / visibleTotal)}`,
          )
          .join("，")
      : "未发现分项记录",
  );
  for (const f of visibleFields) {
    if (!visibleTotal || !report.buckets[f]) continue;
    const segment = element("span", undefined, `segment segment-${f}`);
    segment.style.width = `${(report.buckets[f] / visibleTotal) * 100}%`;
    segment.title = `${labels[f]}：${exact(report.buckets[f])} Token`;
    $("tools-composition").append(segment);
  }
  $("buckets").replaceChildren();
  for (const f of FIELDS) {
    const excluded = !report.includeCache && f.startsWith("cache_"),
      line = element(
        "div",
        undefined,
        "bucket-row" + (excluded ? " excluded" : ""),
      );
    line.append(
      element("span", labels[f], `bucket-label bucket-${f}`),
      element(
        "b",
        excluded
          ? "未计入"
          : report.unavailable?.includes(f)
            ? (report.buckets[f] ? format(report.buckets[f]) + "*" : "未完整提供")
            : report.recordCount
            ? format(report.buckets[f])
            : "—",
      ),
    );
    line.title = report.unavailable?.includes(f) ? "部分调用未提供此分项；总量仅包含已记录的Token。" : excluded
      ? `原始记录 ${exact(report.buckets[f])} Token，未计入当前总量`
      : exact(report.buckets[f]) + " Token";
    $("buckets").append(line);
  }
  $("models").replaceChildren();
  if (!report.models.length) {
    const row = element("tr"),
      cell = element("td", "当前范围未发现模型记录。", "empty");
    cell.colSpan = 3;
    row.append(cell);
    $("models").append(row);
  }
  for (const m of report.models) {
    const row = element("tr"),
      value = element("td", format(m.tokens));
    value.title = exact(m.tokens) + " Token";
    row.append(element("td", m.name), value, element("td", percent(m.share)));
    $("models").append(row);
  }
}
function renderBoard() {
  const entry = board.entry(boardPeriod);
  $("board-refresh").disabled = !!entry.pending;
  $("board-refresh").textContent = entry.pending ? "读取中…" : "刷新榜单";
  document.querySelector(".board-panel").setAttribute("aria-busy", String(!!entry.pending));
  $("board-status").textContent = entry.error || (entry.pending
    ? "正在读取社区榜单…"
    : entry.fetchedAt ? `读取于 ${when(entry.fetchedAt)}` : "");
  for (const button of document.querySelectorAll("[data-period]"))
    button.setAttribute("aria-pressed", String(button.dataset.period === boardPeriod));
  $("board-empty").hidden = !entry.rows || entry.rows.length > 0 || !!entry.pending;
  $("board-rows").replaceChildren();
  const rows = entry.rows || [];
  const maxTokens = Math.max(1, ...rows.map((row) => row.tokens));
  for (const [index, row] of rows.entries()) {
    const tr = element("tr"), member = element("td"), identity = element("div", undefined, "board-member"),
      avatar = element("span", Array.from(row.nickname)[0], "avatar small-avatar"),
      copy = element("div", undefined, "board-member-copy"), tokens = element("td", format(row.tokens));
    if (row.avatar_url) {
      const img = element("img");
      img.alt = "";
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      img.onerror = () => img.remove();
      img.src = row.avatar_url;
      avatar.append(img);
    }
    copy.append(element("b", row.nickname), element("small", row.clients.map((id) => CLIENTS[id] || id).join(" · ")));
    identity.append(avatar, copy);
    member.append(identity);
    tokens.title = exact(row.tokens) + " Token";
    const bar = element("progress", undefined, "board-token-bar");
    bar.max = maxTokens;
    bar.value = row.tokens;
    bar.setAttribute("aria-hidden", "true");
    tokens.append(bar);
    const rank = element("td", String(index + 1), index < 3 ? "board-top-rank" : "");
    rank.setAttribute("aria-label", `第 ${index + 1} 名`);
    const updated = element("td"), time = element("time", when(row.last_synced_at));
    time.dateTime = row.last_synced_at;
    updated.append(time);
    tr.append(rank, member, tokens, updated);
    $("board-rows").append(tr);
  }
}
async function loadBoard(force = false) {
  if (!current) return;
  board.useSite(current.site);
  const pending = board.load(boardPeriod, force);
  renderBoard();
  await pending;
  if (view === "leaderboard") renderBoard();
}
function changeView(next) {
  if (!["overview", "tools", "sources", "leaderboard", "settings"].includes(next)) return;
  view = next;
  for (const control of selectControls) control.close();
  if (next === "settings" && current?.linked)
    void window.clubUsage.action("profile").catch(() => {});
  $("page-title").textContent = {
    overview: "总览",
    tools: "工具与模型",
    sources: "统计来源",
    leaderboard: "社区 Token 排行榜",
    settings: "设置",
  }[next];
  for (const n of ["overview", "tools", "sources", "leaderboard", "settings"])
    $(n + "-view").hidden = n !== next;
  if (next === "settings") markUpdateRead?.();
  $("data-controls").hidden = ["settings", "sources", "leaderboard"].includes(next);
  if (next === "leaderboard") void loadBoard();
  for (const b of document.querySelectorAll("nav [data-view]")) {
    if (b.dataset.view === next) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  if (current)
    $("message").hidden =
      !current.message ||
      (next === "sources" &&
        current.sourcesChanged &&
        current.message.startsWith("来源设置已保存"));
  window.scrollTo({ top: 0 });
}
function render(state) {
  current = state;
  if (board.site !== state.site) {
    board.useSite(state.site);
    if (view === "leaderboard") void loadBoard();
  }
  $("connection").hidden = !state.connection;
  $("code").textContent = state.connection?.code || "";
  $("login-banner").hidden =
    state.linked || !!state.connection || !!state.snapshot || !!state.credentialPending;
  $("credential-notice").hidden = !state.credentialPending || !!state.connection;
  $("restore-connection").disabled = state.busy;
  $("settings-reconnect").hidden = !state.credentialPending;
  $("settings-reconnect").disabled = state.busy;
  $("settings-login").textContent = state.credentialPending ? "恢复社区连接" : "登录社区";
  $("status").textContent = syncStatus(state);
  $("sync-label").textContent = state.busy
    ? "处理中…"
    : state.linked
      ? "读取并同步"
      : "读取本机记录";
  $("message").hidden =
    !state.message ||
    (view === "sources" &&
      state.sourcesChanged &&
      state.message.startsWith("来源设置已保存"));
  $("message").textContent = state.message;
  $("nickname").textContent = state.linked ? state.nickname : "尚未登录";
  $("sidebar-name").textContent = state.linked
    ? state.nickname || "社区成员"
    : "本机记录";
  for (const id of ["sidebar-initial", "account-initial"])
    renderAvatar(id, state);
  $("account-state").textContent = state.linked ? "已连接社区" : state.credentialPending ? "等待系统凭证授权" : "尚未连接社区";
  $("account-state").classList.toggle("connected", !!state.linked);
  $("sidebar-status").textContent = state.linked
    ? "已连接社区"
    : state.credentialPending ? "连接等待授权" : "尚未连接社区";
  document
    .querySelector(".sidebar-account")
    .classList.toggle("linked", !!state.linked);
  $("settings-login").hidden = state.linked;
  $("disconnect").hidden = !state.linked;
  $("pause").setAttribute(
    "aria-checked",
    String(!!state.linked && !!state.enabled),
  );
  $("pause").title = state.enabled ? "暂停自动同步" : "恢复自动同步";
  $("pause").disabled = !state.linked;
  $("last-read").textContent = when(state.lastCollectedAt);
  $("last-upload").textContent = when(state.lastSyncedAt);
  $("startup").checked = state.launchAtLogin;
  $("startup").disabled = !state.packaged;
  if (document.activeElement !== $("site")) $("site").value = state.site;
  $("site").disabled = state.linked || !!state.connection || state.busy || !!state.credentialPending;
  $("save-site").disabled = $("site").disabled;
  for (const name of [
    "sync",
    "collect",
    "login",
    "settings-login",
    "reopen",
    "cancel",
    "disconnect",
  ])
    $(name).disabled = state.busy;
  $("version").textContent = `v${state.version.replace(/ · Tauri$/, "")}`;
  $("diagnostics").textContent =
    `${state.snapshot?.collector || "Tokscale 4.23.1"} · 北京时间 · 仅保存日期、工具、模型与 Token 统计`;
  $("sync-footer").textContent =
    `本机读取 ${when(state.lastCollectedAt)} · 成功上传 ${when(state.lastSyncedAt)}`;
  $("sources-pending").hidden = !state.sourcesChanged;
  for (const id of Object.keys(CLIENTS)) {
    const toggle = $("source-" + id),
      status = state.sourceStatus?.[id];
    if (!state.busy)
      toggle.checked =
        state.sources?.[id] ?? DEFAULT_CLIENTS.includes(id);
    toggle.disabled = state.busy;
    $("source-detected-" + id).textContent = id === "cursor" ? "从 Cursor Usage 页面导出 CSV 后导入" :
      {
        found: "检测到本机记录目录",
        absent: "默认位置未检测到目录",
        unavailable: "目录暂不可访问",
      }[state.detectedSources?.[id]] || "等待目录检测";
    $("source-status-" + id).textContent = !toggle.checked
      ? "已关闭"
      : !status
        ? { absent: "默认位置未检测到目录", unavailable: "目录暂不可访问" }[
            state.detectedSources?.[id]
          ] || "尚未读取"
        : `${{ found: `发现 ${status.rows} 条每日模型统计`, empty: "未发现可用记录", missing: "既有记录未读到，已保留原统计", error: "本次读取未完成，已保留原统计" }[status.state]} · ${when(status.checkedAt)}`;
    toggle.title = $("source-detected-" + id).textContent;
  }
  $("cursor-import").disabled = state.busy;
  $("sources-count").textContent =
    `已开启 ${Object.keys(CLIENTS).filter((id) => $("source-" + id).checked).length} / ${Object.keys(CLIENTS).length}`;
  renderCharts();
}
async function act(name, value) {
  try {
    const result = await window.clubUsage.action(name, value);
    if (!result.ok) {
      $("message").hidden = false;
      $("message").textContent = result.message;
    }
  } catch {
    $("message").hidden = false;
    $("message").textContent = "操作未完成，请稍后重试。";
  }
}
if (window.clubUsage.importCursor) {
  const button = $("cursor-import");
  const picker = $("cursor-file");
  button.hidden = false;
  button.onclick = () => picker.click();
  picker.onchange = async () => {
    const file = picker.files[0];
    picker.value = "";
    if (!file) return;
    try {
      if (file.size > 32 * 1024 * 1024) throw new Error("CSV 超过 32 MB，请缩小导出日期范围。");
      const result = await window.clubUsage.importCursor(await file.text());
      if (!result.ok) throw new Error(result.message);
      render(await window.clubUsage.state());
    } catch (error) {
      $("message").hidden = false;
      $("message").textContent = error.message || "未能导入 Cursor CSV。";
    }
  };
}
for (const [id, name] of Object.entries(CLIENTS)) {
  const option = element("option", name);
  option.value = id;
  $("client").append(option);
  const row = element("label", undefined, "setting-row"),
    info = element("div", undefined, "source-copy"),
    status = element("p", "尚未读取"),
    toggle = element("input");
  const detected = element("p", "等待目录检测", "sr-only");
  detected.id = "source-detected-" + id;
  status.id = "source-status-" + id;
  toggle.type = "checkbox";
  toggle.className = "switch";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute(
    "aria-describedby",
    `source-status-${id} source-detected-${id}`,
  );
  toggle.id = "source-" + id;
  toggle.setAttribute("aria-label", `采集 ${name}`);
  toggle.onchange = async () => {
    await act("source", { client: id, enabled: toggle.checked });
    render(await window.clubUsage.state());
  };
  info.append(element("b", name), detected, status);
  const note = {
    cursor: "同一份账号用量 CSV 只在一台电脑导入，避免跨设备重复累计",
    goose: "推理分项按总量差额推算",
    droid: "会话累计量按采集器规则分配到日期",
  }[id];
  if (note) info.append(element("p", note, "hint"));
  row.append(toolMark(id), info, toggle);
  $("sources-list").append(row);
}
for (const button of document.querySelectorAll("[data-view]"))
  button.onclick = () => changeView(button.dataset.view);
for (const button of document.querySelectorAll("[data-stack]")) {
  button.onclick = () => {
    stackDimension = button.dataset.stack;
    for (const b of document.querySelectorAll("[data-stack]")) b.setAttribute("aria-pressed", String(b === button));
    if (report) dailyChart(report, stackDimension, selectDay);
  };
}
selectControls = ["client", "range"].map((id) => enhanceSelect($(id)));
for (const id of ["client", "range", "cache"])
  $(id).onchange = () => renderCharts(true);
for (const id of ["login", "settings-login", "reopen"])
  $(id).onclick = () => act(current?.credentialPending && id !== "reopen" ? "restore" : "login");
$("restore-connection").onclick = () => act("restore");
$("settings-reconnect").onclick = () => act("login");
$("sync").onclick = () => act("sync");
$("collect").onclick = () => act("collect");
$("cancel").onclick = () => act("cancel");
$("pause").onclick = () => act("pause");
$("account").onclick = () => act("board");
$("board-refresh").onclick = () => void loadBoard(true);
$("board-website").onclick = () => act("board");
for (const button of document.querySelectorAll("[data-period]"))
  button.onclick = () => {
    boardPeriod = button.dataset.period;
    void loadBoard();
  };
$("save-site").onclick = () => act("site", $("site").value.trim());
$("startup").onchange = () => act("startup", $("startup").checked);
$("disconnect").onclick = () => {
  if (confirm("退出后撤销这台电脑的上传权限。本机统计保留，仍可离线查看。"))
    void act("disconnect");
};
$("quit").onclick = () => act("quit");
const markUpdateRead = mountUpdater(window.clubUsage, document);
window.clubUsage.subscribe(render);
window.clubUsage.navigate(changeView);
window.clubUsage.state().then(render);
setInterval(renderCharts, 60_000);
