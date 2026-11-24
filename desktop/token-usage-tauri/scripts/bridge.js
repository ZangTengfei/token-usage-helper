/* Credentials and all filesystem/network operations stay in Rust. */
(() => {
  const { invoke } = window.__TAURI__.core;
  const subscribe = (event, callback) => {
    let cancelled = false,
      remove;
    window.__TAURI__.event
      .listen(event, (e) => callback(e.payload))
      .then((fn) => {
        remove = fn;
        if (cancelled) fn();
      });
    return () => {
      cancelled = true;
      remove?.();
    };
  };
  window.clubUsage = Object.freeze({
    importCursor: (csv) => invoke("usage_action", { action: "cursor-import", value: csv }),
    state: () => invoke("usage_state"),
    updateState: () => invoke("update_state"),
    updateAction: (action) => invoke("update_action", { action }),
    updateSubscribe: (callback) => subscribe("usage-update", callback),
    action: (action, value = null) => invoke("usage_action", { action, value }),
    subscribe: (callback) => subscribe("usage-changed", callback),
    navigate: (callback) => subscribe("usage-navigate", callback),
  });
})();
// WKWebView does not provide Electron's synchronous confirm dialog.
// Keep the explicit logout confirmation using an accessible local HTML dialog.
window.addEventListener("DOMContentLoaded", () => {
  const trigger = document.getElementById("disconnect");
  if (!trigger) return;
  const dialog = document.createElement("dialog");
  const title = document.createElement("h2");
  title.id = "logout-title";
  title.textContent = "退出账号并停止上传？";
  const text = document.createElement("p");
  text.textContent = "这台电脑的上传权限会被撤销，本机统计保留，仍可离线查看。";
  const cancel = document.createElement("button");
  cancel.textContent = "取消";
  cancel.onclick = () => dialog.close();
  const approve = document.createElement("button");
  approve.textContent = "确认退出";
  approve.className = "danger";
  approve.onclick = async () => {
    dialog.close();
    await window.clubUsage.action("disconnect");
  };
  dialog.setAttribute("aria-labelledby", "logout-title");
  dialog.style.maxWidth = "440px";
  dialog.style.borderRadius = "16px";
  dialog.style.padding = "24px";
  dialog.append(title, text, cancel, approve);
  document.body.append(dialog);
  trigger.onclick = () => dialog.showModal();
});
