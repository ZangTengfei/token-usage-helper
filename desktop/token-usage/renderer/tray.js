import { dashboard, syncStatus } from "./analytics.mjs";
const $ = (id) => document.getElementById(id),
  format = (n) =>
    new Intl.NumberFormat("zh-CN", {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(n);
const dailyFormat = (n) =>
  new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
function render(state) {
  const r = dashboard(state.snapshot, { range: 7 });
  $("tray-today").textContent = r.metrics.today.days
    ? format(r.metrics.today.total)
    : "—";
  $("tray-status").textContent = syncStatus(state);
  $("tray-week-total").textContent = r.metrics.week.days
    ? format(r.metrics.week.total)
    : "—";
  const max = Math.max(...r.days.map((d) => d.total), 1);
  $("bars").replaceChildren();
  $("bar-labels").replaceChildren();
  for (const d of r.days) {
    const wrap = document.createElement("div"),
      bar = document.createElement("div"),
      value = document.createElement("span"),
      stack = document.createElement("div"),
      label = document.createElement("span");
    wrap.className = "bar-wrap";
    bar.className = "bar" + (!d.known ? " unknown" : "");
    bar.style.height = `${Math.max(3, (d.total / max) * 100)}%`;
    const description = `${d.date}：${d.known ? d.total.toLocaleString("zh-CN") + " Token" : "未发现记录"}`;
    wrap.title = description;
    wrap.setAttribute("aria-label", description);
    wrap.setAttribute("role", "img");
    value.className = "bar-value";
    value.textContent = d.known ? dailyFormat(d.total) : "—";
    stack.className = "bar-stack";
    stack.append(bar);
    wrap.append(value, stack);
    $("bars").append(wrap);
    label.textContent = d.date.slice(8);
    $("bar-labels").append(label);
  }
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
  $("tray-time").textContent =
    `本机读取 ${when(state.lastCollectedAt)}\n成功上传 ${when(state.lastSyncedAt)} · 斜纹表示未发现记录`;
  $("tray-message").hidden = !state.message;
  $("tray-message").textContent = state.message;
  $("tray-sync").disabled = state.busy;
  $("tray-sync").textContent = state.linked ? "读取并同步" : "读取本机记录";
}
async function act(name, value) {
  const r = await window.clubUsage.action(name, value);
  if (!r.ok) {
    $("tray-message").hidden = false;
    $("tray-message").textContent = r.message;
  }
}
$("tray-open").onclick = () => act("open", "overview");
$("tray-settings").onclick = () => act("open", "settings");
$("tray-sync").onclick = () => act("sync");
$("tray-board").onclick = () => act("board");
$("tray-quit").onclick = () => act("quit");
window.clubUsage.subscribe(render);
window.clubUsage.state().then(render);

// Measure the content rather than reserving space for a possible status message.
let lastHeight = 0;
new ResizeObserver(() => {
  const height = Math.ceil(
    document.querySelector(".tray-shell").getBoundingClientRect().height,
  );
  if (height !== lastHeight) {
    lastHeight = height;
    window.clubUsage.action("tray-height", height).catch(() => {});
  }
}).observe(document.querySelector(".tray-shell"));
