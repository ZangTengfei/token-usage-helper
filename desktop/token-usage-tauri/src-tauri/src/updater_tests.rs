//! Exercise the actual updater HTTP/version/signature path without installing or touching user data.
use std::{
    io::{Read, Write},
    net::TcpListener,
};
use tauri::test::{mock_builder, mock_context, noop_assets};
use tauri_plugin_updater::UpdaterExt;

fn server(mode: &'static str) -> (String, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let url = origin.clone();
    let thread = std::thread::spawn(move || {
        let count = if matches!(mode, "valid" | "tampered" | "wrong-key") {
            2
        } else {
            1
        };
        for _ in 0..count {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0; 8192];
            let n = socket.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..n]);
            assert!(!request.to_lowercase().contains("authorization:"));
            assert!(!request.to_lowercase().contains("cookie:"));
            let (status, body) = if request.starts_with("GET /artifact ") {
                (
                    "200 OK",
                    if mode == "tampered" {
                        b"corrupted download".to_vec()
                    } else {
                        include_bytes!("../tests/fixtures/update.bin").to_vec()
                    },
                )
            } else if mode == "empty" {
                ("204 No Content", vec![])
            } else if mode == "offline" {
                ("503 Service Unavailable", vec![])
            } else if mode == "malformed" {
                ("200 OK", b"not json".to_vec())
            } else {
                let version = if mode == "current" {
                    "0.5.9"
                } else if mode == "older" {
                    "0.5.8"
                } else {
                    "0.6.0"
                };
                let entry = serde_json::json!({"url":format!("{url}/artifact"),"signature":include_str!("../tests/fixtures/update.bin.sig").trim()});
                ("200 OK", serde_json::to_vec(&serde_json::json!({"version":version,"platforms":{"darwin-aarch64":entry,"windows-x86_64":entry}})).unwrap())
            };
            write!(socket, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
            socket.write_all(&body).unwrap();
        }
    });
    (origin, thread)
}
#[tokio::test]
async fn actual_updater_accepts_signed_download_and_rejects_tampering() {
    for mode in [
        "valid",
        "tampered",
        "wrong-key",
        "current",
        "older",
        "empty",
        "offline",
        "malformed",
    ] {
        let (origin, server) = server(mode);
        let mut context = mock_context(noop_assets());
        context.package_info_mut().version = "0.5.9".parse().unwrap();
        // HTTP permission exists ONLY in this unit-test mock context.
        let public = if mode == "wrong-key" {
            serde_json::from_str::<serde_json::Value>(include_str!("../tauri.conf.json")).unwrap()
                ["plugins"]["updater"]["pubkey"]
                .as_str()
                .unwrap()
                .to_owned()
        } else {
            include_str!("../tests/fixtures/update.pub")
                .trim()
                .to_owned()
        };
        context.config_mut().plugins.0.insert("updater".into(), serde_json::json!({
            "pubkey":public,"dangerousInsecureTransportProtocol":true,"endpoints":[format!("{origin}/manifest")]
        }));
        let app = mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap();
        let updater = app
            .updater_builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(3))
            .build()
            .unwrap();
        let result = updater.check().await;
        match mode {
            "valid" | "tampered" | "wrong-key" => {
                let update = result.unwrap().unwrap();
                let bytes = update.download(|_, _| {}, || {}).await;
                assert_eq!(bytes.is_ok(), mode == "valid", "{mode}");
                if let Ok(bytes) = bytes {
                    assert_eq!(bytes, include_bytes!("../tests/fixtures/update.bin"));
                }
            }
            "current" | "older" | "empty" => assert!(result.unwrap().is_none(), "{mode}"),
            _ => assert!(result.is_err(), "{mode}"),
        }
        server.join().unwrap();
    }
}

#[cfg(target_os = "macos")]
#[tokio::test]
#[ignore = "Requires a locally built signed Mac archive; installs into a disposable directory only"]
async fn signed_mac_archive_installs_into_disposable_bundle() {
    let archive = std::path::PathBuf::from(
        std::env::var("CLUB_TEST_UPDATE_ARCHIVE").expect("explicit test archive"),
    );
    let body = std::fs::read(&archive).unwrap();
    let signature = std::fs::read_to_string(format!("{}.sig", archive.display())).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let url = origin.clone();
    let fixture = tempfile::tempdir().unwrap();
    let bundle = fixture.path().join("Isolated.app");
    let executable = bundle.join("Contents/MacOS/aiclub-usage-tauri");
    std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
    std::fs::write(&executable, "old-test-version").unwrap();
    // Configuration and snapshot live outside the replaceable application bundle.
    let settings = fixture.path().join("settings.json");
    let original = br#"{"sources":{"codex":true},"snapshot":{"rows":[]},"pendingUpload":true}"#;
    std::fs::write(&settings, original).unwrap();
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let version = config["version"].as_str().unwrap().to_owned();
    let server_version = version.clone();
    let thread = std::thread::spawn(move || {
        for _ in 0..2 {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0; 8192];
            let n = socket.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..n]);
            let response = if request.starts_with("GET /artifact ") {
                body.clone()
            } else {
                serde_json::to_vec(&serde_json::json!({"version":server_version,"url":format!("{url}/artifact"),"signature":signature.trim()})).unwrap()
            };
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", response.len()).unwrap();
            socket.write_all(&response).unwrap();
        }
    });
    let mut context = mock_context(noop_assets());
    context.package_info_mut().version = "0.0.1".parse().unwrap();
    context.config_mut().plugins.0.insert("updater".into(), serde_json::json!({
        "pubkey":config["plugins"]["updater"]["pubkey"],"dangerousInsecureTransportProtocol":true,"endpoints":[format!("{origin}/manifest")]
    }));
    let app = mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)
        .unwrap();
    let updater = app
        .updater_builder()
        .executable_path(executable)
        .no_proxy()
        .build()
        .unwrap();
    let update = updater.check().await.unwrap().unwrap();
    let bytes = update.download(|_, _| {}, || {}).await.unwrap();
    update.install(bytes).unwrap();
    thread.join().unwrap();
    assert_eq!(std::fs::read(&settings).unwrap(), original);
    let actual = std::process::Command::new("plutil")
        .args(["-extract", "CFBundleShortVersionString", "raw", "-o", "-"])
        .arg(bundle.join("Contents/Info.plist"))
        .output()
        .unwrap();
    assert!(actual.status.success());
    assert_eq!(String::from_utf8(actual.stdout).unwrap().trim(), version);
    assert!(std::process::Command::new("codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(bundle)
        .status()
        .unwrap()
        .success());
}
