use crate::model::{self, Snapshot, CLIENTS};
use crate::source_catalog::LOCAL_CLIENTS;
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

pub const EXECUTABLE: &str = if cfg!(windows) {
    "tokscale.exe"
} else {
    "tokscale"
};

const TOKSCALE_CONFIG_IN_HOME: &str = if cfg!(windows) {
    "AppData/Roaming/tokscale"
} else {
    ".config/tokscale"
};

pub fn detect(home: &Path) -> Value {
    let tokscale_config = if tokscale_core::paths::home_dir().as_deref() == Some(home) {
        tokscale_core::paths::get_config_dir()
    } else {
        home.join(TOKSCALE_CONFIG_IN_HOME)
    };
    let custom =
        |key: &str, fallback: PathBuf| std::env::var_os(key).map(PathBuf::from).unwrap_or(fallback);
    let editor_roots = [
        home.join("Library/Application Support/Code/User/globalStorage"),
        home.join(".config/Code/User/globalStorage"),
        home.join("AppData/Roaming/Code/User/globalStorage"),
        home.join(".vscode-server/data/User/globalStorage"),
    ];
    let extension = |name: &str| {
        editor_roots
            .iter()
            .map(|p| p.join(name).join("tasks"))
            .collect::<Vec<_>>()
    };
    let paths = [
        ("cline", extension("saoudrizwan.claude-dev")),
        ("roocode", extension("rooveterinaryinc.roo-cline")),
        ("kilocode", extension("kilocode.kilo-code")),
        ("copilot", vec![home.join(".copilot")]),
        (
            "workbuddy",
            vec![
                home.join(".workbuddy/projects"),
                home.join(".workbuddy-ai/projects"),
            ],
        ),
        ("hermes", vec![custom("HERMES_HOME", home.join(".hermes"))]),
        (
            "pi",
            vec![custom("PI_CODING_AGENT_DIR", home.join(".pi/agent"))],
        ),
        (
            "goose",
            vec![
                custom("GOOSE_PATH_ROOT", home.join(".local/share/goose")),
                home.join("Library/Application Support/goose"),
                home.join(".local/share/Block/goose"),
                home.join("Library/Application Support/Block/goose"),
                home.join("AppData/Roaming/Block/goose/data"),
            ],
        ),
        (
            "droid",
            vec![custom("DROID_SESSIONS_DIR", home.join(".factory/sessions"))],
        ),
        (
            "codex",
            ["sessions", "archived_sessions"]
                .iter()
                .map(|p| custom("CODEX_HOME", home.join(".codex")).join(p))
                .collect(),
        ),
        (
            "claude",
            ["projects", "transcripts"]
                .iter()
                .map(|p| custom("CLAUDE_CONFIG_DIR", home.join(".claude")).join(p))
                .collect(),
        ),
        (
            "opencode",
            vec![custom("XDG_DATA_HOME", home.join(".local/share")).join("opencode")],
        ),
        (
            "gemini",
            vec![custom("GEMINI_CLI_HOME", home.join(".gemini")).join("tmp")],
        ),
        (
            "kimi",
            vec![
                home.join(".kimi/sessions"),
                home.join(".kimi-code/sessions"),
            ],
        ),
        ("qwen", vec![home.join(".qwen/projects")]),
        (
            "antigravity",
            vec![
                home.join(".gemini/antigravity/conversations"),
                custom("GEMINI_CLI_HOME", home.join(".gemini"))
                    .join("antigravity-cli/conversations"),
                tokscale_config.join("antigravity-cache/sessions"),
            ],
        ),
        ("dsh", vec![custom("DSH_HOME", home.join(".dsh"))]),
        (
            "openclaw",
            [".openclaw", ".clawdbot", ".moltbot", ".moldbot"]
                .iter()
                .map(|p| home.join(p).join("agents"))
                .collect(),
        ),
    ];
    let mut result = json!({});
    for (id, roots) in paths {
        let mut state = "absent";
        for root in roots {
            match std::fs::metadata(root) {
                Ok(m) if m.is_dir() => {
                    state = "found";
                    break;
                }
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => state = "unavailable",
                _ => {}
            }
        }
        result[id] = json!(state);
    }
    if let Some(extra) = crate::local_adapters::detect(home).as_object() {
        result.as_object_mut().unwrap().extend(extra.clone());
    }
    result
}

pub async fn collect(
    executable: &Path,
    clients: &[String],
    home: Option<&Path>,
) -> Result<Snapshot, String> {
    if clients.is_empty() || clients.iter().any(|c| !CLIENTS.contains(&c.as_str())) {
        return Err("请至少开启一个受支持的来源。".into());
    }
    let dir = tempfile::Builder::new()
        .prefix("aiclub-tauri-")
        .tempdir()
        .map_err(|_| "无法创建采集临时目录。")?;
    let output = dir.path().join("graph.json");
    let regular: Vec<String> = clients
        .iter()
        .filter(|c| {
            c.as_str() != "cursor"
                && c.as_str() != "workbuddy"
                && !LOCAL_CLIENTS.contains(&c.as_str())
        })
        .cloned()
        .collect();
    let mut groups = Vec::new();
    if !regular.is_empty() {
        groups.push((regular, home.map(Path::to_path_buf)));
    }
    if clients.iter().any(|c| c == "workbuddy") {
        let source = home
            .map(Path::to_path_buf)
            .or_else(|| {
                std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                    .map(PathBuf::from)
            })
            .ok_or("无法定位 WorkBuddy 调用记录。")?;
        let staged = dir.path().join("workbuddy-home");
        if crate::workbuddy::stage(&source, &staged)? > 0 {
            groups.push((vec!["workbuddy".to_string()], Some(staged)));
        }
    }
    let local = clients
        .iter()
        .filter(|c| LOCAL_CLIENTS.contains(&c.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    let mut rows = if local.is_empty() {
        vec![]
    } else {
        let source = home
            .map(Path::to_path_buf)
            .or_else(|| {
                std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                    .map(PathBuf::from)
            })
            .ok_or("无法定位本地调用记录。")?;
        crate::local_adapters::collect(&source, &local)?
    };
    for (group, group_home) in groups {
        let native_clients = group
            .iter()
            .map(|client| match client.as_str() {
                "antigravity" => "antigravity,antigravity-cli,antigravity-extension",
                id => id,
            })
            .collect::<Vec<_>>()
            .join(",");
        let mut command = tokio::process::Command::new(executable);
        command
            .args([
                "graph",
                "--client",
                &native_clients,
                "--since",
                &model::first(),
                "--until",
                &model::today().to_string(),
                "--no-spinner",
                "--offline",
                "--output",
            ])
            .arg(&output)
            .env("TZ", "Asia/Shanghai")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW for background scans.
        if let Some(home) = group_home {
            command.arg("--home").arg(home);
        }
        let status = tokio::time::timeout(Duration::from_secs(180), command.status())
            .await
            .map_err(|_| "采集超时，请稍后重试。")?
            .map_err(|_| "无法运行内置采集器。")?;
        if !status.success() {
            return Err("采集器未能完成读取，已保留原统计。".into());
        }
        let data = std::fs::read(&output).map_err(|_| "无法读取采集结果。")?;
        let snapshot = model::normalize_graph(
            serde_json::from_slice(&data).map_err(|_| "采集结果格式无效。")?,
        )?;
        if snapshot.rows.iter().any(|r| !group.contains(&r.client)) {
            return Err("采集器返回了未开启来源的数据。".into());
        }
        rows.extend(snapshot.rows);
    }
    let snapshot = Snapshot {
        version: 1,
        collector: if local.is_empty() {
            "tokscale@4.23.1"
        } else {
            "club-usage@1"
        }
        .into(),
        captured_at: model::now(),
        rows,
    };
    snapshot.validate()?;
    Ok(snapshot)
}

pub fn guard_snapshot(
    old: Option<&Snapshot>,
    new: &Snapshot,
    clients: &[String],
) -> Result<(), String> {
    if new.rows.is_empty() {
        return Err("未发现可用记录，已保留上次统计。".into());
    }
    if let Some(old) = old {
        for client in clients {
            if old
                .rows
                .iter()
                .any(|r| &r.client == client && r.date >= model::first())
                && !new.rows.iter().any(|r| &r.client == client)
            {
                return Err(format!(
                    "{client} 的既有记录未读到，已保留原统计。请检查日志或关闭该来源后重试。"
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Row;
    fn snapshot(clients: &[&str]) -> Snapshot {
        Snapshot {
            version: 1,
            collector: "tokscale@4.23.1".into(),
            captured_at: model::now(),
            rows: clients
                .iter()
                .map(|c| Row {
                    date: model::today().to_string(),
                    client: c.to_string(),
                    model: "x".into(),
                    input: 1,
                    output: 0,
                    cache_read: 0,
                    cache_write: 0,
                    reasoning: 0,
                    unavailable: vec![],
                })
                .collect(),
        }
    }
    #[test]
    fn missing_source_and_empty_scan_preserve_previous() {
        let old = snapshot(&["codex", "kimi"]);
        let new = snapshot(&["codex"]);
        assert!(guard_snapshot(Some(&old), &new, &["codex".into(), "kimi".into()]).is_err());
        assert!(guard_snapshot(Some(&old), &new, &["codex".into()]).is_ok());
        assert!(guard_snapshot(None, &snapshot(&[]), &["codex".into()]).is_err());
    }
}

#[cfg(test)]
mod native_tests {
    use super::*;
    fn write(home: &Path, path: &str, lines: &[Value]) {
        let p = home.join(path);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(
            p,
            lines
                .iter()
                .map(|v| v.to_string() + "\n")
                .collect::<String>(),
        )
        .unwrap();
    }
    #[test]
    fn workbuddy_detailed_usage_deduplicates_and_excludes_context_database() {
        let home = tempfile::tempdir().unwrap();
        let staged = tempfile::tempdir().unwrap();
        let executable = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources/collector")
            .join(EXECUTABLE);
        let day = model::today().to_string();
        let epoch = chrono::DateTime::parse_from_rfc3339(&format!("{day}T02:00:01Z"))
            .unwrap()
            .timestamp_millis();
        std::fs::create_dir_all(home.path().join(".workbuddy-ai")).unwrap();
        std::fs::write(
            home.path().join(".workbuddy-ai/workbuddy.db"),
            b"CONTEXT DATABASE MUST NOT BE READ",
        )
        .unwrap();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let clients = vec!["workbuddy".to_string()];
        assert!(runtime
            .block_on(collect(&executable, &clients, Some(home.path())))
            .unwrap()
            .rows
            .is_empty());
        let call = json!({"id":"call","type":"function_call","sessionId":"session-1","timestamp":epoch,"cwd":"PRIVATE","arguments":"PRIVATE","providerData":{"requestModelId":"workbuddy-test","messageId":"request-1","rawUsage":{"input_tokens":100,"output_tokens":30,"cache_read_input_tokens":20,"total_tokens":130}}});
        let mut message = call.clone();
        message["type"] = json!("message");
        message["role"] = json!("assistant");
        message["id"] = json!("reply");
        message["message"] = json!({"content":"PRIVATE"});
        for root in [".workbuddy", ".workbuddy-ai"] {
            write(
                home.path(),
                &format!("{root}/projects/p/session-1.jsonl"),
                &[call.clone(), message.clone()],
            );
        }
        assert_eq!(
            crate::workbuddy::stage(home.path(), staged.path()).unwrap(),
            4
        );
        let clean =
            std::fs::read_to_string(staged.path().join(".workbuddy/projects/p/session-1.jsonl"))
                .unwrap();
        assert!(!clean.contains("PRIVATE"));
        assert!(!staged.path().join(".workbuddy-ai/workbuddy.db").exists());
        assert_eq!(detect(home.path())["workbuddy"], "found");
        assert!(!model::defaults()["workbuddy"]);
        let result = runtime
            .block_on(collect(&executable, &clients, Some(home.path())))
            .unwrap();
        assert_eq!(result.rows.len(), 1);
        let row = &result.rows[0];
        assert_eq!(
            (
                row.client.as_str(),
                row.input,
                row.output,
                row.cache_read,
                row.total()
            ),
            ("workbuddy", 80, 30, 20, 130)
        );
        let mixed = runtime
            .block_on(collect(
                &executable,
                &["codex".into(), "workbuddy".into()],
                Some(home.path()),
            ))
            .unwrap();
        assert_eq!(mixed.rows, result.rows);
    }
    #[test]
    fn pinned_native_collector_and_filters() {
        let home = tempfile::tempdir().unwrap();
        let day = model::today().to_string();
        let stamp = format!("{day}T02:00:01Z");
        let epoch = chrono::DateTime::parse_from_rfc3339(&stamp)
            .unwrap()
            .timestamp_millis();
        write(
            home.path(),
            ".codex/sessions/rollout-fixture.jsonl",
            &[
                json!({"timestamp":stamp,"type":"session_meta","payload":{"id":"fixture","timestamp":stamp,"cwd":"/PRIVATE"}}),
                json!({"timestamp":stamp,"type":"turn_context","payload":{"model":"test-model","cwd":"/PRIVATE"}}),
                json!({"timestamp":stamp,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":20,"output_tokens":30,"reasoning_output_tokens":5},"last_token_usage":{"input_tokens":100,"cached_input_tokens":20,"output_tokens":30,"reasoning_output_tokens":5}}}}),
            ],
        );
        write(
            home.path(),
            ".gemini/tmp/project/chats/session-fixture.json",
            &[
                json!({"sessionId":"gemini-fixture","projectHash":"fixture","startTime":stamp,"lastUpdated":stamp,"messages":[{"id":"1","type":"gemini","timestamp":stamp,"model":"gemini-test","tokens":{"input":100,"output":30,"cached":20,"thoughts":5,"total":135}}]}),
            ],
        );
        write(
            home.path(),
            ".kimi/sessions/project/session/wire.jsonl",
            &[
                json!({"timestamp":epoch/1000,"message":{"type":"StatusUpdate","payload":{"message_id":"kimi-1","token_usage":{"input_other":80,"output":30,"input_cache_read":20,"input_cache_creation":5}}}}),
            ],
        );
        write(
            home.path(),
            ".qwen/projects/project/chats/session.jsonl",
            &[
                json!({"type":"assistant","timestamp":stamp,"sessionId":"qwen-fixture","model":"qwen-test","usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":30,"cachedContentTokenCount":20,"thoughtsTokenCount":5,"totalTokenCount":130}}),
            ],
        );
        let claw = json!({"type":"message","id":"claw-fixture","message":{"role":"assistant","model":"claw-test","provider":"anthropic","timestamp":epoch,"usage":{"input":80,"output":30,"cacheRead":20,"cacheWrite":5}}});
        write(
            home.path(),
            ".openclaw/agents/main/sessions/session.jsonl",
            &[claw.clone()],
        );
        write(
            home.path(),
            ".openclaw/agents/main/sessions/fork.jsonl",
            &[claw],
        );
        write(
            home.path(),
            ".dsh/sessions/project/session/session.jsonl",
            &[
                json!({"type":"session","id":"dsh-test","cwd":"/PRIVATE"}),
                json!({"type":"assistant/message","seq":1,"time":epoch,"data":{"message":{"id":"dsh-msg","source":{"provider":"deepseek","model":"deepseek-test"}},"usage":{"inputTokens":80,"outputTokens":30,"cacheReadTokens":20,"cacheWriteTokens":5,"reasoningTokens":5}}}),
            ],
        );
        assert_eq!(detect(home.path())["dsh"], "found");
        write(
            home.path(),
            &format!("{TOKSCALE_CONFIG_IN_HOME}/antigravity-cache/sessions/legacy.jsonl"),
            &[json!({
                "type": "usage", "sessionId": "legacy", "responseId": "reply",
                "timestamp": epoch, "modelId": "gemini-2.5-pro",
                "input": 80, "output": 30, "cacheRead": 20, "reasoning": 5
            })],
        );
        assert_eq!(detect(home.path())["antigravity"], "found");
        assert!(!model::defaults()["antigravity"]);
        let executable = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources/collector")
            .join(EXECUTABLE);
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let clients = [
                "codex",
                "gemini",
                "kimi",
                "qwen",
                "openclaw",
                "dsh",
                "antigravity",
            ]
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>();
            let snapshot = collect(&executable, &clients, Some(home.path()))
                .await
                .unwrap();
            assert_eq!(snapshot.rows.len(), 7);
            for row in &snapshot.rows {
                assert_eq!(
                    row.total(),
                    if ["codex", "qwen", "antigravity"].contains(&row.client.as_str()) {
                        130
                    } else {
                        135
                    },
                    "{}",
                    row.client
                );
            }
            assert!(!serde_json::to_string(&snapshot)
                .unwrap()
                .contains("PRIVATE"));
            let subset = collect(&executable, &["qwen".into()], Some(home.path()))
                .await
                .unwrap();
            assert_eq!(subset.rows.len(), 1);
            assert_eq!(subset.rows[0].client, "qwen");
        });
    }
}
