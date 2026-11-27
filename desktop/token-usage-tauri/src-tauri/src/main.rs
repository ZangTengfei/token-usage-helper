#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]
mod collector;
mod credentials;
mod cursor_csv;
mod local_adapters;
mod model;
#[cfg(target_os = "macos")]
mod resume;
mod source_catalog;
mod store;
mod updater;
#[cfg(test)]
mod updater_tests;
mod workbuddy;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt;

fn verify(window: &tauri::WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|_| "Invalid renderer")?;
    let path = match window.label() {
        "main" => "/renderer/index.html",
        "tray" => "/renderer/tray.html",
        _ => return Err("Invalid renderer".into()),
    };
    if !local_url(&url, path) {
        return Err("Invalid renderer".into());
    }
    Ok(())
}
fn local_url(url: &tauri::Url, path: &str) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost")
        || url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
        && url.path() == path
}
fn show(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}
#[tauri::command]
fn usage_state(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    store: tauri::State<'_, Arc<store::Store>>,
) -> Result<Value, String> {
    verify(&window)?;
    Ok(store.state(&app))
}
#[tauri::command]
async fn usage_action(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    store: tauri::State<'_, Arc<store::Store>>,
    action: String,
    value: Value,
) -> Result<Value, String> {
    verify(&window)?;
    if action == "tray-height" {
        if window.label() != "tray" {
            return Err("Invalid renderer".into());
        }
        let height = value
            .as_u64()
            .filter(|v| (200..=800).contains(v))
            .ok_or("无效面板尺寸。")?;
        window
            .set_size(LogicalSize::new(380.0, height as f64))
            .map_err(|_| "无法调整面板。")?;
        return Ok(json!({"ok":true}));
    }
    if action == "open" {
        let view = value
            .as_str()
            .filter(|v| ["overview", "tools", "sources", "leaderboard", "settings"].contains(v))
            .ok_or("无效页面。")?;
        if let Some(w) = app.get_webview_window("tray") {
            let _ = w.hide();
        }
        show(&app);
        app.emit_to("main", "usage-navigate", view)
            .map_err(|_| "无法切换页面。")?;
        return Ok(json!({"ok":true}));
    }
    if action == "leaderboard" {
        return store.leaderboard(value).await;
    }
    if action == "quit" {
        if app.state::<Arc<updater::Updates>>().installing() {
            return Err("正在安装更新，请稍候。".into());
        }
        app.exit(0);
        return Ok(json!({"ok":true}));
    }
    let Ok(_guard) = store.operation.try_lock() else {
        return Ok(json!({"ok":false,"message":"正在读取或连接，请稍后重试。"}));
    };
    if action == "profile" {
        store.refresh_profile(&app, true).await;
        return Ok(json!({"ok":true}));
    }
    store.busy(true, "working");
    store.emit(&app);
    let result: Result<(), String> = match action.as_str() {
        "collect" => store.sync(&app, false).await,
        "sync" => store.sync(&app, true).await,
        "login" => store.login(&app).await,
        "restore" => store.restore_connection(),
        "cancel" => store.cancel().await,
        "disconnect" => store.disconnect().await,
        "source" => store.source(value),
        "cursor-import" => store.import_cursor(&value),
        "site" => store.site(value),
        "pause" => match store.pause() {
            Ok(true) => store.sync(&app, true).await,
            Ok(false) => Ok(()),
            Err(e) => Err(e),
        },
        "board" => store.open(&app, "/token-usage"),
        "startup" => match value.as_bool() {
            Some(true) => app
                .autolaunch()
                .enable()
                .map_err(|_| "无法设置开机启动。".into()),
            Some(false) => app
                .autolaunch()
                .disable()
                .map_err(|_| "无法关闭开机启动。".into()),
            None => Err("无效启动设置。".into()),
        },
        _ => Err("不支持的操作。".into()),
    };
    store.busy(false, "idle");
    let response = match result {
        Ok(()) => json!({"ok":true}),
        Err(message) => {
            store.message(message.clone());
            json!({"ok":false,"message":message})
        }
    };
    store.emit(&app);
    Ok(response)
}

#[tauri::command]
fn update_state(
    window: tauri::WebviewWindow,
    updates: tauri::State<'_, Arc<updater::Updates>>,
) -> Result<updater::Status, String> {
    verify(&window)?;
    Ok(updates.state())
}
#[tauri::command]
async fn update_action(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    updates: tauri::State<'_, Arc<updater::Updates>>,
    store: tauri::State<'_, Arc<store::Store>>,
    action: String,
) -> Result<(), String> {
    verify(&window)?;
    if window.label() != "main" {
        return Err("Invalid renderer".into());
    }
    match action.as_str() {
        "check" => updates.check(&app).await,
        "install" => {
            let _guard = store
                .operation
                .try_lock()
                .map_err(|_| "正在读取或同步，请完成后再更新。")?;
            updates.install(&app).await
        }
        _ => Err("不支持的更新操作。".into()),
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            usage_state,
            usage_action,
            update_state,
            update_action
        ])
        .setup(|app| {
            let main = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::App("renderer/index.html".into()),
            )
            .title("AI Club Token 用量助手")
            .inner_size(1080.0, 860.0)
            .min_inner_size(820.0, 650.0)
            .on_navigation(|u| local_url(u, "/renderer/index.html"))
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .build()?;
            let tray = WebviewWindowBuilder::new(
                app,
                "tray",
                WebviewUrl::App("renderer/tray.html".into()),
            )
            .title("Token 用量速览")
            .inner_size(380.0, 520.0)
            .visible(false)
            .decorations(false)
            .resizable(false)
            .skip_taskbar(true)
            .always_on_top(true)
            .on_navigation(|u| local_url(u, "/renderer/tray.html"))
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .build()?;
            let tray_copy = tray.clone();
            tray.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Focused(false)) {
                    let _ = tray_copy.hide();
                }
            });
            let main_copy = main.clone();
            main.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = main_copy.hide();
                }
            });
            let updates = Arc::new(updater::Updates::default());
            app.manage(updates.clone());
            let update_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                loop {
                    let _ = updates.check(&update_handle).await;
                    tokio::time::sleep(std::time::Duration::from_secs(24 * 60 * 60)).await;
                }
            });
            let state = Arc::new(store::Store::new(app.handle()).map_err(std::io::Error::other)?);
            app.manage(state.clone());
            let open = tauri::menu::MenuItem::with_id(app, "open", "打开面板", true, None::<&str>)?;
            let quit = tauri::menu::MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = tauri::menu::Menu::with_items(app, &[&open, &quit])?;
            tauri::tray::TrayIconBuilder::with_id("usage")
                .icon(tauri::image::Image::from_bytes(include_bytes!(
                    "../resources/tray@2x.png"
                ))?)
                .icon_as_template(false)
                .tooltip("AI Club Token 用量助手")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show(app),
                    "quit" => {
                        if !app.state::<Arc<updater::Updates>>().installing() {
                            app.exit(0);
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|icon, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        rect,
                        ..
                    } = event
                    {
                        if let Some(w) = icon.app_handle().get_webview_window("tray") {
                            if w.is_visible().unwrap_or(false) {
                                let _ = w.hide();
                                return;
                            }
                            let scale = w.scale_factor().unwrap_or(1.0);
                            let pos = rect.position.to_physical::<f64>(scale);
                            let size = rect.size.to_physical::<f64>(scale);
                            let mut x = (pos.x + size.width / 2.0 - 190.0 * scale) as i32;
                            let mut y = (pos.y + size.height + 6.0 * scale) as i32;
                            if let Ok(Some(m)) = w.current_monitor() {
                                let origin = m.position();
                                let screen = m.size();
                                x = x
                                    .max(origin.x)
                                    .min(origin.x + screen.width as i32 - (380.0 * scale) as i32);
                                y = y
                                    .min(
                                        origin.y + screen.height as i32
                                            - w.outer_size()
                                                .map(|s| s.height as i32)
                                                .unwrap_or(520),
                                    )
                                    .max(origin.y);
                            }
                            let _ = w.set_position(PhysicalPosition::new(x, y));
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                    let Ok(_guard) = state.operation.try_lock() else {
                        continue;
                    };
                    let result = if state.has_pending() {
                        state.poll(&handle).await
                    } else if state.due() {
                        state.sync(&handle, true).await
                    } else if state.profile_due() {
                        state.refresh_profile(&handle, false).await;
                        continue;
                    } else {
                        continue;
                    };
                    if let Err(e) = result {
                        state.message(e);
                    }
                    state.busy(false, "idle");
                    state.emit(&handle);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("无法启动 Tauri 用量助手")
        .run(|app, event| {
            #[cfg(not(target_os = "macos"))]
            let _ = (app, &event);
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                show(app);
            }
        });
}
