use crate::source_catalog::DEFAULT_CLIENTS;
use crate::{
    collector, credentials,
    model::{self, Settings, CLIENTS},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::{rngs::OsRng, RngCore};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, sync::Mutex, time::Duration};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_opener::OpenerExt;

#[derive(Clone)]
pub struct Pending {
    id: String,
    code: String,
    expires_at: String,
    token: String,
    secret: String,
}
pub struct Data {
    pub settings: Settings,
    pub token: Option<String>,
    credential_pending: bool,
    pending: Option<Pending>,
    pub busy: bool,
    pub stage: String,
    pub message: String,
    pub detected: Value,
    last_attempt: Option<chrono::DateTime<chrono::Utc>>,
    last_profile_attempt: Option<chrono::DateTime<chrono::Utc>>,
}
pub struct Store {
    pub inner: Mutex<Data>,
    pub operation: tokio::sync::Mutex<()>,
    path: PathBuf,
    home: PathBuf,
    pub executable: PathBuf,
    fixture_home: Option<PathBuf>,
    service: String,
    client: reqwest::Client,
}
#[derive(Debug)]
pub struct ApiError {
    pub status: u16,
    pub message: String,
}
fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn secret() -> String {
    let mut data = [0u8; 32];
    OsRng.fill_bytes(&mut data);
    URL_SAFE_NO_PAD.encode(data)
}

impl Store {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let home = app.path().home_dir().map_err(|_| "无法定位用户目录。")?;
        let isolated = std::env::var_os("CLUB_USAGE_TAURI_DATA");
        let directory = isolated.clone().map(PathBuf::from).unwrap_or(
            app.path()
                .app_data_dir()
                .map_err(|_| "无法定位配置目录。")?,
        );
        std::fs::create_dir_all(&directory).map_err(|_| "无法创建配置目录。")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
                .map_err(|_| "无法保护配置目录。")?;
        }
        let path = directory.join("settings.json");
        let mut message = String::new();
        let mut settings = if path.exists() {
            match std::fs::read(&path)
                .ok()
                .and_then(|b| serde_json::from_slice::<Settings>(&b).ok())
            {
                Some(s) => s,
                None => return Err("配置文件损坏。为保留原数据，未覆盖配置。".into()),
            }
        } else if isolated.is_none() {
            let old = if cfg!(windows) {
                app.path()
                    .config_dir()
                    .map_err(|_| "无法定位旧配置目录。")?
                    .join("AI Club 用量助手/settings.json")
            } else {
                home.join("Library/Application Support/AI Club 用量助手/settings.json")
            };
            match std::fs::read(old)
                .ok()
                .and_then(|b| serde_json::from_slice::<Settings>(&b).ok())
            {
                Some(mut s) => {
                    s.nickname.clear();
                    s.avatar_url.clear();
                    s.last_synced_at = None;
                    s.pending_upload = s.snapshot.is_some();
                    message="已复制旧版本机统计和来源设置。试用版独立保存，首次连接需重新登录；同一台电脑请在授权页选择原设备。".into();
                    s
                }
                None => Settings::default(),
            }
        } else {
            Settings::default()
        };
        if let Ok(site) = std::env::var("CLUB_USAGE_TAURI_SITE") {
            settings.site = site;
        }
        settings.site = model::validate_site(&settings.site)?;
        settings.sources = CLIENTS
            .iter()
            .map(|id| {
                (
                    id.to_string(),
                    settings
                        .sources
                        .get(*id)
                        .copied()
                        .unwrap_or(DEFAULT_CLIENTS.contains(id)),
                )
            })
            .collect();
        if !settings.sources.values().any(|v| *v) {
            settings.sources = model::defaults();
        }
        if let Some(s) = settings.snapshot.as_mut() {
            s.rows
                .retain(|r| r.date >= model::first() && r.date <= model::today().to_string());
            if s.validate().is_err() {
                settings.snapshot = None;
                message = "旧版统计格式无法直接迁移，请重新读取本机记录。".into();
            }
        }
        if !settings.source_status.is_object() {
            settings.source_status = json!({});
        }
        let service = if isolated.is_some() {
            format!(
                "club.changzhouai.usage.tauri.test.{}",
                digest(&directory.to_string_lossy())
            )
        } else {
            "club.changzhouai.usage.tauri".into()
        };
        let mut credential_pending = false;
        let token = match credentials::read(&service, false) {
            Ok(t) => {
                let token = credentials::decode(&t, &settings.site);
                if token.is_none() {
                    message = "系统保存的凭证无效，请重新连接社区。".into();
                }
                token
            }
            Err(keyring::Error::NoEntry) => None,
            Err(_) => {
                credential_pending = true;
                None
            }
        };
        let executable = app
            .path()
            .resource_dir()
            .map_err(|_| "无法定位采集器。")?
            .join("collector")
            .join(collector::EXECUTABLE);
        let detected = collector::detect(&home);
        let store = Self {
            inner: Mutex::new(Data {
                settings,
                token,
                credential_pending,
                pending: None,
                busy: false,
                stage: "idle".into(),
                message,
                detected,
                last_attempt: None,
                last_profile_attempt: None,
            }),
            operation: tokio::sync::Mutex::new(()),
            path,
            home,
            executable,
            fixture_home: if isolated.is_some() {
                std::env::var_os("CLUB_USAGE_TAURI_COLLECTOR_HOME").map(PathBuf::from)
            } else {
                None
            },
            service,
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|_| "无法初始化网络。")?,
        };
        store.save()?;
        Ok(store)
    }
    pub fn save(&self) -> Result<(), String> {
        let bytes = serde_json::to_vec(&self.inner.lock().unwrap().settings)
            .map_err(|_| "无法保存本机统计。")?;
        let mut tmp = tempfile::NamedTempFile::new_in(self.path.parent().unwrap())
            .map_err(|_| "无法创建配置临时文件。")?;
        use std::io::Write;
        tmp.write_all(&bytes)
            .and_then(|_| tmp.as_file().sync_all())
            .map_err(|_| "无法保存本机统计。")?;
        tmp.persist(&self.path).map_err(|_| "无法替换本机配置。")?;
        Ok(())
    }
    fn save_token(&self, token: &str) -> Result<(), String> {
        keyring::Entry::new(&self.service, "upload")
            .map_err(|_| "无法访问系统凭证存储。")?
            .set_password(
                &json!({"site":self.inner.lock().unwrap().settings.site,"token":token}).to_string(),
            )
            .map_err(|_| "凭证未保存：请允许访问系统凭证存储后重试。".into())
    }
    pub fn restore_connection(&self) -> Result<(), String> {
        let site = {
            let d = self.inner.lock().unwrap();
            if d.token.is_some() || d.pending.is_some() {
                return Err("请先完成当前连接操作。".into());
            }
            d.settings.site.clone()
        };
        // Interactive access is only reachable from the user's restore button.
        let raw = match credentials::read(&self.service, true) {
            Ok(raw) => raw,
            Err(keyring::Error::NoEntry) => {
                self.inner.lock().unwrap().credential_pending = false;
                return Err("未找到已保存的连接，请重新登录社区。".into());
            }
            Err(_) => return Err("未恢复连接。允许系统凭证访问后可重试，本机统计不受影响。".into()),
        };
        let token = credentials::decode(&raw, &site).ok_or("已保存的连接无效，请重新连接社区。")?;
        {
            let mut d = self.inner.lock().unwrap();
            d.token = Some(token);
            d.credential_pending = false;
            d.last_profile_attempt = None;
        }
        self.message("社区连接已恢复。");
        Ok(())
    }
    fn delete_token(&self) -> Result<(), String> {
        match keyring::Entry::new(&self.service, "upload")
            .map_err(|_| "无法访问系统凭证存储。")?
            .delete_credential()
        {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("社区已撤销连接，但本机系统凭证未删除，请重试退出。".into()),
        }
    }
    pub fn state(&self, app: &AppHandle) -> Value {
        let d = self.inner.lock().unwrap();
        let s = &d.settings;
        json!({"site":s.site,"linked":d.token.is_some(),"credentialPending":d.credential_pending,"nickname":s.nickname,"avatarUrl":model::safe_avatar_url(&s.avatar_url),"enabled":s.enabled,"busy":d.busy,"message":d.message,"lastSyncedAt":s.last_synced_at,"summary":null,"snapshot":s.snapshot,"lastCollectedAt":s.last_collected_at,"pendingUpload":s.pending_upload,"sources":s.sources,"sourceStatus":s.source_status,"sourcesChanged":s.sources_changed,"detectedSources":d.detected,"stage":d.stage,"connection":d.pending.as_ref().map(|p|json!({"code":p.code,"expiresAt":p.expires_at})),"version":env!("CARGO_PKG_VERSION"),"packaged":true,"launchAtLogin":app.autolaunch().is_enabled().unwrap_or(false)})
    }
    pub fn emit(&self, app: &AppHandle) {
        let _ = app.emit("usage-changed", self.state(app));
    }
    pub fn message(&self, value: impl Into<String>) {
        self.inner.lock().unwrap().message = value.into();
    }
    pub fn busy(&self, busy: bool, stage: &str) {
        let mut d = self.inner.lock().unwrap();
        d.busy = busy;
        d.stage = stage.into();
    }
    async fn request(
        &self,
        path: &str,
        body: Option<Value>,
        token: Option<&str>,
        method: reqwest::Method,
    ) -> Result<Value, ApiError> {
        let site = self.inner.lock().unwrap().settings.site.clone();
        let mut request = self.client.request(method, format!("{site}{path}"));
        if let Some(body) = body {
            request = request.json(&body);
        }
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        let response = request.send().await.map_err(|_| ApiError {
            status: 0,
            message: "暂时无法连接社区，请检查网络后重试。".into(),
        })?;
        let status = response.status();
        let value: Value = response.json().await.map_err(|_| ApiError {
            status: status.as_u16(),
            message: "社区返回了无效响应。".into(),
        })?;
        if !status.is_success() {
            return Err(ApiError {
                status: status.as_u16(),
                message: value["message"]
                    .as_str()
                    .unwrap_or("社区操作未完成。")
                    .chars()
                    .take(300)
                    .collect(),
            });
        }
        Ok(value)
    }
    pub async fn leaderboard(&self, period: Value) -> Result<Value, String> {
        let period = period
            .as_str()
            .filter(|v| ["today", "7d", "30d", "all"].contains(v))
            .ok_or("无效的榜单周期。")?;
        let site = self.inner.lock().unwrap().settings.site.clone();
        // Public data: never attach the device credential or hold the sync lock.
        let data = self
            .request(
                &format!("/api/token-usage/leaderboard?period={period}"),
                None,
                None,
                reqwest::Method::GET,
            )
            .await
            .map_err(|e| e.message)?;
        Ok(json!({"ok":true,"site":site,"data":data}))
    }
    pub fn open(&self, app: &AppHandle, path: &str) -> Result<(), String> {
        if !path.starts_with("/token-usage") {
            return Err("无效社区页面。".into());
        }
        let site = self.inner.lock().unwrap().settings.site.clone();
        app.opener()
            .open_url(format!("{site}{path}"), None::<&str>)
            .map_err(|_| "无法打开系统浏览器。".into())
    }
    pub async fn login(&self, app: &AppHandle) -> Result<(), String> {
        let previous = {
            let d = self.inner.lock().unwrap();
            if d.token.is_some() {
                return Err("请先退出当前账号。".into());
            }
            d.pending.clone()
        };
        if let Some(p) = previous {
            return self.open(app, &format!("/token-usage/connect?id={}", p.id));
        }
        let token = format!("club_usage_{}", secret());
        let secret = secret();
        let result=self.request("/api/token-usage/connect",Some(json!({"action":"start","name":"Token 用量助手","token_hash":digest(&token),"poll_hash":digest(&secret)})),None,reqwest::Method::POST).await.map_err(|e|e.message)?;
        let id = result["id"]
            .as_str()
            .filter(|s| s.len() == 36 && s.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'))
            .ok_or("连接编号无效。")?
            .to_string();
        let code = result["code"]
            .as_str()
            .filter(|s| s.len() <= 32)
            .ok_or("连接码无效。")?
            .to_string();
        let expires_at = result["expires_at"]
            .as_str()
            .filter(|s| chrono::DateTime::parse_from_rfc3339(s).is_ok())
            .ok_or("连接有效期无效。")?
            .to_string();
        self.inner.lock().unwrap().pending = Some(Pending {
            id: id.clone(),
            code,
            expires_at,
            token,
            secret,
        });
        self.message("在系统浏览器中核对连接码并确认。同一台电脑重新连接时请选择原设备。");
        self.open(app, &format!("/token-usage/connect?id={id}"))
    }
    pub async fn cancel(&self) -> Result<(), String> {
        let pending = self.inner.lock().unwrap().pending.take();
        if let Some(p) = pending {
            self.request(
                "/api/token-usage/connect",
                Some(json!({"action":"cancel","id":p.id,"secret":p.secret})),
                None,
                reqwest::Method::POST,
            )
            .await
            .map_err(|_| "未能通知服务器取消；连接将在十分钟内过期。")?;
        }
        self.message("已取消连接。");
        Ok(())
    }
    pub fn profile_due(&self) -> bool {
        let d = self.inner.lock().unwrap();
        d.token.is_some()
            && d.last_profile_attempt
                .map_or(true, |t| (chrono::Utc::now() - t).num_seconds() >= 3600)
    }
    pub async fn refresh_profile(&self, app: &AppHandle, force: bool) {
        let (token, site) = {
            let mut d = self.inner.lock().unwrap();
            let Some(token) = d.token.clone() else { return };
            if d.last_profile_attempt.is_some_and(|t| {
                (chrono::Utc::now() - t).num_seconds() < if force { 60 } else { 3600 }
            }) {
                return;
            }
            d.last_profile_attempt = Some(chrono::Utc::now());
            (token, d.settings.site.clone())
        };
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            self.request(
                "/api/token-usage/device",
                None,
                Some(&token),
                reqwest::Method::GET,
            ),
        )
        .await;
        let Ok(Ok(profile)) = result else { return };
        if !profile["nickname"].is_string() || profile.get("avatar_url").is_none() {
            return;
        }
        {
            let mut d = self.inner.lock().unwrap();
            if d.token.as_deref() != Some(token.as_str()) || d.settings.site != site {
                return;
            }
            d.settings.nickname = profile["nickname"]
                .as_str()
                .unwrap_or("社区成员")
                .to_string();
            d.settings.avatar_url =
                model::safe_avatar_url(profile["avatar_url"].as_str().unwrap_or(""));
        }
        let _ = self.save();
        self.emit(app);
    }
    pub async fn poll(&self, app: &AppHandle) -> Result<(), String> {
        let pending = self.inner.lock().unwrap().pending.clone();
        let Some(p) = pending else { return Ok(()) };
        if chrono::DateTime::parse_from_rfc3339(&p.expires_at).map_err(|_| "连接有效期无效。")?
            <= chrono::Utc::now()
        {
            self.inner.lock().unwrap().pending = None;
            self.message("连接已过期，请重新登录。");
            return Ok(());
        }
        let result = self
            .request(
                "/api/token-usage/connect",
                Some(json!({"action":"poll","id":p.id,"secret":p.secret})),
                None,
                reqwest::Method::POST,
            )
            .await
            .map_err(|e| e.message)?;
        match result["state"].as_str() {
            Some("approved") => {
                if let Err(error) = self.save_token(&p.token) {
                    // A denied OS dialog must not be retried by the 3-second poll loop.
                    self.inner.lock().unwrap().pending = None;
                    return Err(error);
                }
                {
                    let mut d = self.inner.lock().unwrap();
                    d.token = Some(p.token);
                    d.credential_pending = false;
                    d.last_profile_attempt = None;
                    d.settings.avatar_url.clear();
                    d.pending = None;
                    d.settings.nickname = result["nickname"].as_str().unwrap_or("社区成员").into();
                    d.settings.enabled = true;
                }
                self.save()?;
                self.message("已连接，正在同步。");
                self.emit(app);
                self.sync(app, true).await?;
            }
            Some("denied" | "expired" | "superseded") => {
                self.inner.lock().unwrap().pending = None;
                self.message("连接已取消或失效，请重新登录。");
            }
            _ => {}
        }
        Ok(())
    }
    pub async fn sync(&self, app: &AppHandle, upload: bool) -> Result<(), String> {
        let (clients, old, token) = {
            let mut d = self.inner.lock().unwrap();
            d.last_attempt = Some(chrono::Utc::now());
            d.detected = collector::detect(&self.home);
            (
                d.settings
                    .sources
                    .iter()
                    .filter(|(_, v)| **v)
                    .map(|(k, _)| k.clone())
                    .collect::<Vec<_>>(),
                d.settings.snapshot.clone(),
                d.token.clone(),
            )
        };
        self.busy(true, "reading");
        self.message("正在读取本机记录…");
        self.emit(app);
        let mut snapshot = match collector::collect(
            &self.executable,
            &clients,
            self.fixture_home.as_deref(),
        )
        .await
        {
            Ok(s) => s,
            Err(e) => {
                let mut d = self.inner.lock().unwrap();
                for c in clients {
                    d.settings.source_status[&c] =
                        json!({"state":"error","checkedAt":model::now()});
                }
                drop(d);
                let _ = self.save();
                return Err(e);
            }
        };
        if clients.iter().any(|c| c == "cursor") {
            crate::cursor_csv::restore(&self.path.with_file_name("cursor.sqlite3"), &mut snapshot)?;
        }
        {
            let mut d = self.inner.lock().unwrap();
            for c in &clients {
                let rows = snapshot.rows.iter().filter(|r| &r.client == c).count();
                d.settings.source_status[c] = json!({"state":if rows>0{"found"}else{"empty"},"rows":rows,"checkedAt":model::now()});
            }
        }
        if let Err(e) = collector::guard_snapshot(old.as_ref(), &snapshot, &clients) {
            let _ = self.save();
            return Err(e);
        }
        {
            let mut d = self.inner.lock().unwrap();
            d.settings.snapshot = Some(snapshot.clone());
            d.settings.last_collected_at = Some(model::now());
            d.settings.pending_upload = true;
            d.settings.sources_changed = false;
        }
        self.save()?;
        self.emit(app);
        if !upload || token.is_none() {
            self.message("本机统计已更新；尚未上传社区。");
            return Ok(());
        }
        self.busy(true, "uploading");
        self.message("本机统计已保存，正在上传社区…");
        self.emit(app);
        match self
            .request(
                "/api/token-usage/sync",
                Some(serde_json::to_value(snapshot).map_err(|_| "统计格式无效。")?),
                token.as_deref(),
                reqwest::Method::POST,
            )
            .await
        {
            Ok(result) if result["ok"] == true => {
                let mut d = self.inner.lock().unwrap();
                d.settings.last_synced_at = Some(model::now());
                d.settings.pending_upload = false;
                drop(d);
                self.save()
                    .map_err(|_| "社区已接收统计，但本机上传状态未保存。")?;
                self.message("读取与上传均已完成。");
                Ok(())
            }
            Ok(_) => Err("本机统计已保存，社区尚未确认接收，请稍后重试。".into()),
            Err(e) => {
                if e.status == 401 {
                    self.inner.lock().unwrap().settings.enabled = false;
                    self.save()?;
                    Err("社区连接已失效，已暂停上传。请退出账号后重新登录；本机统计已保留。".into())
                } else {
                    Err(format!("本机统计已保存，上传未完成：{}", e.message))
                }
            }
        }
    }
    pub fn import_cursor(&self, value: &Value) -> Result<(), String> {
        let content = value.as_str().ok_or("请选择 Cursor 用量 CSV。")?;
        let mut snapshot = self
            .inner
            .lock()
            .unwrap()
            .settings
            .snapshot
            .clone()
            .unwrap_or_else(|| model::Snapshot {
                version: 1,
                collector: "club-usage@1".into(),
                captured_at: model::now(),
                rows: Vec::new(),
            });
        let first = model::first();
        snapshot.rows.retain(|r| r.date >= first);
        snapshot.captured_at = model::now();
        let message = crate::cursor_csv::import(
            &self.path.with_file_name("cursor.sqlite3"),
            content,
            &mut snapshot,
        )?;
        let rows = snapshot
            .rows
            .iter()
            .filter(|r| r.client == "cursor")
            .count();
        {
            let mut d = self.inner.lock().unwrap();
            d.settings.sources.insert("cursor".into(), true);
            d.settings.source_status["cursor"] =
                json!({"state":"found","rows":rows,"checkedAt":snapshot.captured_at});
            d.settings.last_collected_at = Some(snapshot.captured_at.clone());
            d.settings.snapshot = Some(snapshot);
            d.settings.pending_upload = true;
        }
        self.save()?;
        self.message(message);
        Ok(())
    }
    pub fn source(&self, value: Value) -> Result<(), String> {
        let client = value["client"]
            .as_str()
            .filter(|s| CLIENTS.contains(s))
            .ok_or("无效统计来源。")?;
        let enabled = value["enabled"].as_bool().ok_or("无效来源开关。")?;
        {
            let mut d = self.inner.lock().unwrap();
            let mut next = d.settings.sources.clone();
            next.insert(client.into(), enabled);
            if !next.values().any(|v| *v) {
                return Err("请至少保留一个来源；停止上传请暂停自动同步。".into());
            }
            d.settings.sources = next;
            d.settings.sources_changed = true;
        }
        self.save()?;
        self.message("来源设置已保存，下次成功读取和同步后生效。");
        Ok(())
    }
    pub fn site(&self, value: Value) -> Result<(), String> {
        let site = model::validate_site(value.as_str().ok_or("无效社区地址。")?)?;
        {
            let mut d = self.inner.lock().unwrap();
            if d.token.is_some() || d.pending.is_some() || d.credential_pending {
                return Err("请先退出或取消连接，再修改社区地址。".into());
            }
            d.settings.site = site;
            d.settings.last_synced_at = None;
            d.settings.pending_upload = d.settings.snapshot.is_some();
        }
        self.save()
    }
    pub async fn disconnect(&self) -> Result<(), String> {
        let token = {
            let mut d = self.inner.lock().unwrap();
            d.settings.enabled = false;
            d.token.clone()
        };
        self.save()?;
        if let Some(token) = token {
            match self
                .request(
                    "/api/token-usage/device",
                    None,
                    Some(&token),
                    reqwest::Method::DELETE,
                )
                .await
            {
                Ok(_) => {}
                Err(e) if e.status == 401 => {}
                Err(_) => return Err("已暂停同步，暂时无法撤销社区连接，请联网后重试退出。".into()),
            }
            self.delete_token()?;
            {
                let mut d = self.inner.lock().unwrap();
                d.token = None;
                d.settings.nickname.clear();
                d.settings.avatar_url.clear();
                d.settings.last_synced_at = None;
                d.settings.pending_upload = d.settings.snapshot.is_some();
            }
            self.save()?;
        }
        self.message("已退出账号，本机统计保留。");
        Ok(())
    }
    pub fn pause(&self) -> Result<bool, String> {
        let enabled = {
            let mut d = self.inner.lock().unwrap();
            d.settings.enabled = !d.settings.enabled;
            d.settings.enabled
        };
        self.save()?;
        self.message(if enabled {
            "已恢复自动同步。"
        } else {
            "自动同步已暂停。"
        });
        Ok(enabled)
    }
    pub fn has_pending(&self) -> bool {
        self.inner.lock().unwrap().pending.is_some()
    }
    pub fn due(&self) -> bool {
        let d = self.inner.lock().unwrap();
        let elapsed = d
            .last_attempt
            .map(|t| (chrono::Utc::now() - t).num_seconds() >= 3600)
            .unwrap_or(true);
        let since = d
            .settings
            .last_synced_at
            .as_deref()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|t| (chrono::Utc::now() - t.with_timezone(&chrono::Utc)).num_seconds() >= 3600)
            .unwrap_or(true);
        d.token.is_some() && d.settings.enabled && elapsed && since
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    #[test]
    fn credential_manager_roundtrip() {
        let service = format!("aiclub-ci-test-{}", std::process::id());
        let entry = keyring::Entry::new(&service, "fixture").unwrap();
        entry.set_password("test-only-not-a-real-token").unwrap();
        let read = entry.get_password();
        entry.delete_credential().unwrap();
        assert_eq!(read.unwrap(), "test-only-not-a-real-token");
        assert!(matches!(entry.get_password(), Err(keyring::Error::NoEntry)));
    }
}
