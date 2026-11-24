import {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  shell,
  Tray,
  Menu,
  nativeImage,
  powerMonitor,
  screen,
} from "electron";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostname } from "node:os";
import { UsageController, siteOrigin } from "./core.mjs";
import { collect, detectSources } from "./vendor/collector.mjs";
import { APP_NAME, LEGACY_STORAGE_NAME } from "./branding.mjs";
const root = dirname(fileURLToPath(import.meta.url));
const collectorName =
  process.platform === "win32" ? "tokscale.exe" : "tokscale";
// Keep the existing settings directory and pre-ready keychain namespace.
// Electron captures its macOS safeStorage service name before ready.
app.setPath(
  "userData",
  process.env.CLUB_USAGE_APP_DATA ||
    join(app.getPath("appData"), LEGACY_STORAGE_NAME),
);
app.setName(LEGACY_STORAGE_NAME);
let window,
  trayWindow,
  trayMenu,
  tray,
  controller,
  quitting = false,
  timer;
const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
else {
  app.on("second-instance", () => show());
  app.on("activate", () => show());
  app.on("window-all-closed", () => {});
  app.on("before-quit", () => {
    quitting = true;
    clearInterval(timer);
  });
  app
    .whenReady()
    .then(async () => {
      app.setName(APP_NAME);
      app.setAboutPanelOptions({ applicationName: APP_NAME });
      const directory = app.getPath("userData"),
        file = join(directory, "settings.json");
      let settings = {},
        loadError = "";
      try {
        const stored = JSON.parse(await readFile(file, "utf8"));
        settings = { ...stored };
        delete settings.credential;
        if (stored.credential) {
          if (!safeStorage.isEncryptionAvailable())
            throw new Error("系统凭证存储暂不可用");
          settings.token = safeStorage.decryptString(
            Buffer.from(stored.credential, "base64"),
          );
        }
      } catch (e) {
        if (e.code !== "ENOENT") {
          settings = {};
          loadError = "无法读取上次连接，请重新登录社区。";
        }
      }
      if (!settings.site) {
        try {
          const build = JSON.parse(
            await readFile(join(root, "vendor/build-config.json"), "utf8"),
          );
          settings.site = siteOrigin(build.site);
        } catch {
          /* Normal builds use the public community origin. */
        }
      }
      // Environment override is only a development/test entry point, never a renderer capability.
      if (process.env.CLUB_USAGE_SITE && !settings.token)
        settings.site = siteOrigin(process.env.CLUB_USAGE_SITE);
      let saveQueue = Promise.resolve();
      function save(next) {
        const job = async () => {
          const stored = { ...next };
          delete stored.token;
          if (next.token) {
            if (
              !safeStorage.isEncryptionAvailable() ||
              (process.platform === "linux" &&
                safeStorage.getSelectedStorageBackend() === "basic_text")
            )
              throw new Error("系统安全存储暂不可用，请解锁系统钥匙串后重试。");
            stored.credential = safeStorage
              .encryptString(next.token)
              .toString("base64");
          }
          await mkdir(directory, { recursive: true, mode: 0o700 });
          await writeFile(file + ".tmp", JSON.stringify(stored), {
            mode: 0o600,
          });
          await rename(file + ".tmp", file);
        };
        const pending = saveQueue.then(job, job);
        saveQueue = pending.catch(() => {});
        return pending;
      }
      controller = new UsageController({
        settings,
        detectedSources: await detectSources(),
        save,
        collect: async (clients) => {
          controller.detectedSources = await detectSources();
          return collect(
            app.isPackaged
              ? join(process.resourcesPath, "collector", collectorName)
              : join(root, "vendor", collectorName),
            clients,
            app.isPackaged ? undefined : process.env.CLUB_USAGE_TEST_HOME,
          );
        },
        open: async (target) => {
          const url = new URL(target);
          if (
            url.origin !== controller.settings.site ||
            !url.pathname.startsWith("/token-usage")
          )
            throw new Error("不允许打开此地址。");
          await shell.openExternal(url.href);
        },
        changed: () => broadcast(),
      });
      controller.message = loadError;
      const state = () => ({
        ...controller.state(),
        launchAtLogin: app.getLoginItemSettings().openAtLogin,
        version: app.getVersion(),
        packaged: app.isPackaged,
      });
      ipcMain.handle("usage:state", (event) => {
        verify(event);
        return state();
      });
      ipcMain.handle("usage:action", async (event, action, value) => {
        verify(event);
        try {
          if (action === "tray-height") {
            if (
              event.sender !== trayWindow?.webContents ||
              !Number.isInteger(value) ||
              value < 200 ||
              value > 800
            )
              throw new Error("无效面板尺寸。");
            const bounds = trayWindow.getBounds();
            const area = screen.getDisplayMatching(bounds).workArea;
            const height = Math.min(value, area.height);
            if (bounds.height !== height) {
              trayWindow.setContentSize(380, height);
              if (trayWindow.isVisible())
                trayWindow.setPosition(
                  bounds.x,
                  Math.max(
                    area.y,
                    Math.min(bounds.y, area.y + area.height - height),
                  ),
                );
            }
            // Sizing is presentation-only; do not broadcast and trigger another render.
            return { ok: true };
          }
          if (action === "leaderboard") {
            try { return await controller.leaderboard(value); }
            catch { return { ok: false }; }
          }
          if (action === "profile") await controller.refreshProfile(true);
          else if (action === "login") await controller.start(hostname());
          else if (action === "source") await controller.setSource(value);
          else if (action === "cancel") await controller.cancel();
          else if (action === "sync") await controller.sync();
          else if (action === "collect")
            await controller.sync({ upload: false });
          else if (action === "open") {
            if (!["overview", "tools", "sources", "leaderboard", "settings"].includes(value))
              throw new Error("无效页面");
            show();
            trayWindow?.hide();
            window.webContents.send("usage:navigate", value);
          } else if (action === "pause") await controller.pause();
          else if (action === "disconnect") await controller.disconnect();
          else if (action === "site") {
            if (typeof value !== "string" || value.length > 300)
              throw new Error("无效的社区地址。");
            await controller.setSite(value);
          } else if (action === "board")
            await controller.open(controller.settings.site + "/token-usage");
          else if (action === "startup") {
            if (typeof value !== "boolean" || !app.isPackaged)
              throw new Error("请在安装后的 App 中设置开机启动。");
            app.setLoginItemSettings({ openAtLogin: value });
          } else if (action === "quit") {
            app.quit();
          } else throw new Error("不支持的操作。");
          broadcast();
          return { ok: true };
        } catch (e) {
          controller.message = e.message;
          broadcast();
          return { ok: false, message: e.message };
        }
      });
      function verify(event) {
        const target = [window, trayWindow].find(
          (w) => w && !w.isDestroyed() && event.sender === w.webContents,
        );
        const file = target === window ? "index.html" : "tray.html";
        if (
          !target ||
          event.senderFrame !== target.webContents.mainFrame ||
          event.senderFrame.url !==
            pathToFileURL(join(root, "renderer", file)).href
        )
          throw new Error("Invalid renderer");
      }
      function broadcast() {
        for (const target of [window, trayWindow])
          if (target && !target.isDestroyed())
            target.webContents.send("usage:changed", state());
        updateMenu();
      }
      function updateMenu() {
        if (!tray) return;
        trayMenu = Menu.buildFromTemplate([
          { label: "打开用量助手", click: () => show() },
          {
            label: controller.settings.token
              ? `已连接 · ${controller.settings.nickname}`
              : "尚未登录",
            enabled: false,
          },
          { type: "separator" },
          {
            label: "立即同步",
            enabled: !controller.busy,
            click: () => controller.sync(),
          },
          {
            label: controller.settings.enabled
              ? "暂停自动同步"
              : "恢复自动同步",
            enabled: Boolean(controller.settings.token),
            click: () =>
              controller.pause().catch((e) => {
                controller.message = e.message;
                broadcast();
              }),
          },
          {
            label: "查看社区榜单",
            click: () =>
              controller
                .open(controller.settings.site + "/token-usage")
                .catch(() => {}),
          },
          { type: "separator" },
          { label: "退出用量助手", click: () => app.quit() },
        ]);
      }
      window = new BrowserWindow({
        width: 1080,
        height: 860,
        minWidth: 820,
        minHeight: 650,
        show: false,
        title: APP_NAME,
        backgroundColor: "#f5f7f6",
        icon: join(root, "vendor/icon.png"),
        webPreferences: {
          preload: join(root, "preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
        },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      window.webContents.session.setPermissionRequestHandler(
        (_contents, _permission, callback) => callback(false),
      );
      window.on("close", (event) => {
        if (!quitting) {
          event.preventDefault();
          window.hide();
        }
      });
      window.on("ready-to-show", () => window.show());
      await window.loadFile(join(root, "renderer/index.html"));
      // Dedicated 22x22 pt badge; @2x/@3x assets retain sharpness on Retina.
      const trayIcon = nativeImage.createFromPath(
        join(root, "vendor/tray.png"),
      );
      trayIcon.setTemplateImage(false);
      tray = new Tray(trayIcon);
      tray.setToolTip(APP_NAME);
      trayWindow = new BrowserWindow({
        width: 380,
        height: 520,
        show: false,
        frame: false,
        resizable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        backgroundColor: "#f7f9f6",
        title: "Token 用量速览",
        webPreferences: {
          preload: join(root, "preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
        },
      });
      trayWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      trayWindow.webContents.on("will-navigate", (event) =>
        event.preventDefault(),
      );
      trayWindow.on("blur", () => trayWindow.hide());
      await trayWindow.loadFile(join(root, "renderer/tray.html"));
      function toggleTray() {
        if (trayWindow.isVisible()) {
          trayWindow.hide();
          return;
        }
        const bounds = tray.getBounds(),
          area = screen.getDisplayNearestPoint({
            x: bounds.x,
            y: bounds.y,
          }).workArea;
        const x = Math.round(
          Math.min(
            Math.max(bounds.x + bounds.width / 2 - 190, area.x),
            area.x + area.width - 380,
          ),
        );
        const y = Math.round(
          Math.min(
            Math.max(bounds.y + bounds.height + 6, area.y),
            area.y + area.height - trayWindow.getBounds().height,
          ),
        );
        trayWindow.setPosition(x, y);
        trayWindow.show();
        trayWindow.focus();
        broadcast();
      }
      tray.on("click", toggleTray);
      tray.on("right-click", () => tray.popUpContextMenu(trayMenu));
      updateMenu();
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
          {
            label: "编辑",
            submenu: [
              { role: "undo" },
              { role: "redo" },
              { type: "separator" },
              { role: "cut" },
              { role: "copy" },
              { role: "paste" },
              { role: "selectAll" },
            ],
          },
          { label: "窗口", submenu: [{ role: "minimize" }, { role: "close" }] },
        ]),
      );
      timer = setInterval(
        () =>
          void Promise.all([
            controller.tick(),
            controller.refreshProfile(),
          ]).catch((e) => {
            controller.message = e.message;
            broadcast();
          }),
        3000,
      );
      powerMonitor.on("resume", () => void controller.tick().catch(() => {}));
      const initial =
        !controller.settings.snapshot &&
        controller.settings.summary &&
        controller.settings.token
          ? controller.sync({ upload: Boolean(controller.settings.enabled) })
          : controller.tick();
      void controller.refreshProfile();
      void initial.catch((e) => {
        controller.message = e.message;
        broadcast();
      });
    })
    .catch((error) => {
      console.error("App initialization failed:", error.message);
      app.quit();
    });
}
function show() {
  if (window && !window.isDestroyed()) {
    window.show();
    window.focus();
  }
}
