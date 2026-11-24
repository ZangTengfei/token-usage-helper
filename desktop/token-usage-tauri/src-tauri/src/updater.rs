//! Update state is memory-only and independent of account/site configuration.
use serde::Serialize;
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    phase: &'static str,
    version: Option<String>,
    message: String,
    downloaded: usize,
    total: Option<u64>,
}
impl Default for Status {
    fn default() -> Self {
        Self {
            phase: "idle",
            version: None,
            message: "启动后自动检查更新".into(),
            downloaded: 0,
            total: None,
        }
    }
}
#[derive(Default)]
pub struct Updates {
    status: Mutex<Status>,
    pending: Mutex<Option<Update>>,
    last_check: Mutex<Option<Instant>>,
    operation: tokio::sync::Mutex<()>,
}
impl Updates {
    pub fn state(&self) -> Status {
        self.status.lock().unwrap().clone()
    }
    fn set(&self, app: &AppHandle, phase: &'static str, message: impl Into<String>) {
        let mut status = self.status.lock().unwrap();
        status.phase = phase;
        status.message = message.into();
        let _ = app.emit("usage-update", status.clone());
    }
    pub fn installing(&self) -> bool {
        matches!(
            self.status.lock().unwrap().phase,
            "downloading" | "installing"
        )
    }
    pub async fn check(&self, app: &AppHandle) -> Result<(), String> {
        let Ok(_guard) = self.operation.try_lock() else {
            return Ok(());
        };
        {
            let mut last = self.last_check.lock().unwrap();
            if last.is_some_and(|t| t.elapsed() < Duration::from_secs(60)) {
                return Ok(());
            }
            *last = Some(Instant::now());
        }
        self.set(app, "checking", "正在检查更新…");
        // No device token, account, custom site or renderer-supplied URL is sent.
        let result = async {
            app.updater_builder()
                .timeout(Duration::from_secs(15))
                .build()?
                .check()
                .await
        }
        .await;
        match result {
            Ok(Some(mut update)) => {
                update.timeout = Some(Duration::from_secs(300));
                self.status.lock().unwrap().version = Some(update.version.clone());
                *self.pending.lock().unwrap() = Some(update);
                self.set(app, "available", "有新版本可用");
                Ok(())
            }
            Ok(None) => {
                *self.pending.lock().unwrap() = None;
                self.status.lock().unwrap().version = None;
                self.set(app, "current", "已是最新版本");
                Ok(())
            }
            Err(_) => {
                // Preserve a previously checked update for retry after a transient outage.
                self.set(app, "error", "暂时无法检查更新，请稍后重试。");
                Err("暂时无法检查更新，请稍后重试。".into())
            }
        }
    }
    pub async fn install(&self, app: &AppHandle) -> Result<(), String> {
        let _guard = self
            .operation
            .try_lock()
            .map_err(|_| "正在检查或安装更新，请稍候。")?;
        let update = self
            .pending
            .lock()
            .unwrap()
            .clone()
            .ok_or("请先检查更新。")?;
        {
            let mut s = self.status.lock().unwrap();
            s.downloaded = 0;
            s.total = None;
        }
        self.set(app, "downloading", "正在下载更新…");
        let mut last_emit = Instant::now();
        let mut progress = |downloaded: usize, total| {
            let mut s = self.status.lock().unwrap();
            s.downloaded = downloaded;
            s.total = total;
            if last_emit.elapsed() >= Duration::from_millis(250) {
                let _ = app.emit("usage-update", s.clone());
                last_emit = Instant::now();
            }
        };
        #[cfg(target_os = "macos")]
        let bytes = async {
            use tauri::Manager;
            let dir = app
                .path()
                .app_cache_dir()
                .map_err(|_| "无法定位更新缓存。")?
                .join("updater-download");
            let key = app.config().plugins.0["updater"]["pubkey"]
                .as_str()
                .ok_or("缺少更新公钥。")?;
            crate::resume::download(
                &dir,
                update.download_url.as_str(),
                &update.signature,
                key,
                &update.version,
                |n, total| progress(n as usize, total),
            )
            .await
        }
        .await;
        #[cfg(not(target_os = "macos"))]
        let bytes = {
            let mut downloaded = 0;
            update
                .download(
                    |chunk, total| {
                        downloaded += chunk;
                        progress(downloaded, total);
                    },
                    || {},
                )
                .await
                .map_err(|_| "下载或校验失败，请检查网络并重试。")
        };
        let bytes = bytes.map_err(|msg| {
            self.set(app, "error", msg);
            msg.to_string()
        })?;
        self.set(app, "installing", "正在安装，完成后自动重启…");
        if update.install(bytes).is_err() {
            let msg = if cfg!(target_os = "macos") {
                "更新包已下载并校验，但无法替换应用。请退出助手，将它移到可写的「应用程序」目录后重试，或从官网下载完整包。"
            } else {
                "安装失败，请退出助手后重新安装。"
            };
            self.set(app, "error", msg);
            return Err(msg.into());
        }
        // Windows NSIS updater exits/relaunches via installer; macOS restarts here.
        app.restart();
    }
}
