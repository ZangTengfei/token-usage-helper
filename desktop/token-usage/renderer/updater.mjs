// Tauri owns downloads and signature verification. Electron preview hides this UI.
export function mountUpdater(api, document) {
  if (!api.updateState || !api.updateAction || !api.updateSubscribe) return;
  const panel = document.getElementById("app-update");
  const status = document.getElementById("update-status");
  const check = document.getElementById("update-check");
  const install = document.getElementById("update-install");
  const notice = document.getElementById("update-notice");
  const progress = document.getElementById("update-progress");
  const dot = document.getElementById("update-dot");
  const settings = document.getElementById("settings-view");
  const readKey = "lastSeenUpdateVersion";
  let version, seenVersion;
  try { seenVersion = localStorage.getItem(readKey); } catch { /* Storage may be unavailable. */ }
  function markRead() {
    if (!version || seenVersion === version) return;
    seenVersion = version;
    dot.hidden = true;
    try { localStorage.setItem(readKey, version); } catch { /* Keep the in-memory state. */ }
  }
  let busy = false;
  function render(state) {
    panel.hidden = false;
    version = state.version;
    dot.hidden = !version || seenVersion === version;
    if (!settings.hidden) markRead();
    busy = ["checking", "downloading", "installing"].includes(state.phase);
    check.disabled = busy;
    install.disabled = busy;
    install.hidden = !state.version;
    install.textContent = state.phase === "downloading" ? "正在下载…" : state.phase === "installing" ? "正在安装…" : state.phase === "error" && state.downloaded > 0 ? "继续更新" : "更新并重启";
    status.textContent = state.version ? `v${state.version} · ${state.message}` : state.message;
    notice.hidden = !state.version;
    notice.textContent = busy ? "正在更新…" : `更新至 v${state.version}`;
    progress.hidden = state.phase !== "downloading";
    if (state.total > 0) {
      progress.max = state.total;
      progress.value = Math.min(state.downloaded, state.total);
    } else progress.removeAttribute("value");
  }
  async function act(action) {
    if (busy) return;
    // Disable immediately, before the first IPC event (double-click protection).
    busy = true;
    check.disabled = install.disabled = true;
    try { await api.updateAction(action); }
    catch (error) { status.textContent = typeof error === "string" ? error : "操作未完成，请重试。"; }
    finally {
      busy = false;
      check.disabled = install.disabled = false;
    }
  }
  check.onclick = () => act("check");
  install.onclick = () => act("install");
  notice.onclick = () => {
    document.querySelector('[data-view="settings"]').click();
    panel.scrollIntoView({ block: "center" });
    install.focus();
  };
  api.updateSubscribe(render);
  void api.updateState().then(render).catch(() => {});
  return markRead;
}
