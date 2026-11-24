//! Local usage adapters select metadata only; no credentials or conversation text.
use crate::model::{self, Row};
use chrono::{DateTime, TimeZone, Utc};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    time::Duration,
};
const FIELDS: [&str; 5] = ["input", "output", "cache_read", "cache_write", "reasoning"];
fn count(v: &Value) -> Result<u64, String> {
    v.as_u64()
        .filter(|n| *n <= 1_000_000_000_000)
        .ok_or("用量字段不是有效非负整数。".into())
}
fn get<'a>(v: &'a Value, keys: &[&str]) -> &'a Value {
    keys.iter()
        .find_map(|key| v.get(*key).filter(|v| !v.is_null()))
        .unwrap_or(&Value::Null)
}
// Recorded Kiro input excludes cache. Missing buckets remain explicitly unavailable.
fn kiro_tokens(meta: &Value) -> Result<Option<(Vec<u64>, Vec<String>)>, String> {
    let nested = get(meta, &["token_usage", "usage"]);
    let aliases: [&[&str]; 5] = [
        &["input_tokens", "uncached_input_tokens", "input_token_count"],
        &["output_tokens", "output_token_count"],
        &[
            "cache_read_input_tokens",
            "cache_read_input_token_count",
            "cache_read_tokens",
            "cache_read",
        ],
        &[
            "cache_write_input_tokens",
            "cache_write_input_token_count",
            "cache_creation_input_tokens",
            "cache_write_tokens",
            "cache_write",
        ],
        &[
            "reasoning_tokens",
            "reasoning_token_count",
            "thinking_tokens",
        ],
    ];
    let mut values = Vec::new();
    let mut unavailable = Vec::new();
    for (i, keys) in aliases.iter().enumerate() {
        let flat = get(meta, keys);
        let raw = if flat.is_null() {
            get(nested, keys)
        } else {
            flat
        };
        if raw.is_null() {
            unavailable.push(FIELDS[i].into());
            values.push(0);
        } else {
            values.push(count(raw)?);
        }
    }
    if values.iter().all(|n| *n == 0) {
        return Ok(None);
    }
    if !unavailable.iter().any(|f| f == "output") {
        values[1] = values[1]
            .checked_sub(values[4])
            .ok_or("Kiro 推理分项超过输出总量。")?;
    }
    Ok(Some((values, unavailable)))
}
fn tokens(u: &Value, kind: &str, legacy: bool) -> Result<Option<(Vec<u64>, Vec<String>)>, String> {
    if !u.is_object() {
        return Ok(None);
    }
    let raw = if kind == "teleagent" {
        vec![
            &u["input"],
            &u["output"],
            &u["cache"]["read"],
            &u["cache"]["write"],
            &u["reasoning"],
        ]
    } else if kind == "qoder-ide" {
        vec![
            &u["prompt_tokens"],
            &u["completion_tokens"],
            &u["cached_tokens"],
            &u["cache_creation_input_tokens"],
            &u["reasoning_tokens"],
        ]
    } else {
        vec![
            get(
                u,
                &["input", "input_tokens", "prompt_tokens", "inputTokens"],
            ),
            get(
                u,
                &[
                    "output",
                    "output_tokens",
                    "completion_tokens",
                    "outputTokens",
                ],
            ),
            get(
                u,
                &[
                    "cache_read",
                    "cache_read_input_tokens",
                    "input_cache_read",
                    "cache_read_tokens",
                    "cacheReadTokens",
                ],
            ),
            get(
                u,
                &[
                    "cache_write",
                    "cache_creation_input_tokens",
                    "input_cache_creation",
                    "cache_write_tokens",
                    "cacheCreationTokens",
                ],
            ),
            get(u, &["reasoning", "reasoning_tokens", "reasoningTokens"]),
        ]
    };
    if raw[0].is_null() || raw[1].is_null() {
        return Ok(None);
    }
    let missing = raw
        .iter()
        .enumerate()
        .filter(|(_, v)| v.is_null())
        .map(|(i, _)| FIELDS[i].to_string())
        .collect();
    let mut values = raw
        .iter()
        .map(|v| if v.is_null() { Ok(0) } else { count(v) })
        .collect::<Result<Vec<_>, _>>()?;
    if values.iter().all(|v| *v == 0) {
        return Ok(None);
    }
    let total = get(
        u,
        &[
            "computed_total_tokens",
            "total",
            "totalTokens",
            "total_tokens",
        ],
    );
    let total = if total.is_null() {
        None
    } else {
        Some(count(total)?)
    };
    let mut inclusive = kind.starts_with("qoder") || legacy;
    if kind == "zcode" {
        if let Some(total) = total {
            let base = values[0] + values[1];
            let separate = values.iter().sum::<u64>();
            if total == base && separate != base {
                inclusive = true;
            } else if total == separate {
                inclusive = false;
            } else {
                return Err("ZCode 总量与分项不一致。".into());
            }
        }
    }
    if kind == "zcode" && !legacy && total.is_none() && values[2..].iter().any(|v| *v > 0) {
        return Err("ZCode 缺少可核验缓存口径的总量。".into());
    }
    if kind == "qoder-cli" {
        if let Some(total) = total {
            let base = values[0] + values[1];
            let separate = values.iter().sum::<u64>();
            if total == base {
                inclusive = true;
            } else if total == separate {
                inclusive = false;
            } else {
                return Err("Qoder 总量与分项不一致。".into());
            }
        } else {
            // SDK BetaUsage input excludes cache; Credits never selects a token convention.
            let native =
                !get(u, &["input_tokens"]).is_null() && !get(u, &["output_tokens"]).is_null();
            let openai =
                !get(u, &["prompt_tokens"]).is_null() && !get(u, &["completion_tokens"]).is_null();
            if native {
                inclusive = false;
                values[1] = values[1]
                    .checked_sub(values[4])
                    .ok_or("缓存或推理分项超过所属总量。")?;
            } else if !openai && values[2..].iter().any(|v| *v > 0) {
                return Err("Qoder CLI 的用量字段口径无法识别，已保留原统计。".into());
            }
        }
    }
    if inclusive {
        values[0] = values[0]
            .checked_sub(values[2] + values[3])
            .ok_or("缓存分项超过输入总量。")?;
        values[1] = values[1]
            .checked_sub(values[4])
            .ok_or("推理分项超过输出总量。")?;
    }
    Ok(Some((values, missing)))
}
fn epoch(v: &Value) -> Option<i64> {
    let n = v
        .as_i64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .or_else(|| {
            v.as_str()
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .map(|d| d.timestamp_millis())
        })?;
    (n > 0).then_some(if n < 100_000_000_000 { n * 1000 } else { n })
}
fn object(v: &Value) -> Value {
    if let Some(s) = v.as_str() {
        serde_json::from_str(s).unwrap_or(Value::Null)
    } else {
        v.clone()
    }
}
fn dirs(root: &Path) -> Result<Vec<PathBuf>, String> {
    match fs::read_dir(root) {
        Ok(entries) => entries
            .map(|e| e.map_err(|_| "无法读取用量目录。".to_string()))
            .filter_map(|e| match e {
                Ok(e) => match e.file_type() {
                    Ok(t) if t.is_dir() => Some(Ok(e.path())),
                    Ok(_) => None,
                    Err(_) => Some(Err("无法读取用量目录。".into())),
                },
                Err(e) => Some(Err(e)),
            })
            .collect(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(_) => Err("无法读取用量目录。".into()),
    }
}
pub fn paths(
    home: &Path,
    selected: Option<&[String]>,
) -> Result<BTreeMap<String, (Vec<PathBuf>, Vec<PathBuf>)>, String> {
    let tele = home.join(".local/share/TeleAgent");
    let mut tele_db = vec![tele.join("teleagent.db")];
    tele_db.extend(
        (if selected.is_some_and(|s| !s.iter().any(|c| c == "teleagent")) {
            vec![]
        } else {
            dirs(&tele.join("users"))?
        })
        .iter()
        .map(|p| p.join("teleagent.db")),
    );
    let use_env = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .as_deref()
        == Some(home);
    let appdata = if use_env {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else {
        None
    };
    let config = if use_env {
        std::env::var_os("QODER_CONFIG_DIR").map(PathBuf::from)
    } else {
        None
    };
    let support = [
        home.join("Library/Application Support"),
        appdata.unwrap_or_else(|| home.join("AppData/Roaming")),
        home.join(".config"),
    ];
    let qoder_db = ["Qoder", "QoderCN"]
        .iter()
        .flat_map(|app| {
            support
                .iter()
                .map(move |p| p.join(app).join("SharedClientCache/cache/db/local.db"))
        })
        .collect();
    Ok(BTreeMap::from([
        (
            "zcode".into(),
            (
                vec![home.join(".zcode/cli/db/db.sqlite")],
                vec![home.join(".zcode/projects")],
            ),
        ),
        ("teleagent".into(), (tele_db, vec![])),
        (
            "kiro".into(),
            (
                vec![
                    home.join("Library/Application Support/kiro-cli/data.sqlite3"),
                    home.join(".local/share/kiro-cli/data.sqlite3"),
                ],
                vec![home.join(".kiro/sessions/cli")],
            ),
        ),
        (
            "qoder".into(),
            (
                qoder_db,
                vec![
                    config
                        .unwrap_or_else(|| home.join(".qoder"))
                        .join("projects"),
                    home.join(".qoder-cn/projects"),
                ],
            ),
        ),
    ]))
}
pub fn detect(home: &Path) -> Value {
    let mut result = json!({});
    match paths(home, None) {
        Ok(paths) => {
            for (id, (db, logs)) in paths {
                let mut state = "absent";
                for p in db.iter().chain(logs.iter()) {
                    match fs::metadata(p) {
                        Ok(_) => {
                            state = "found";
                            break;
                        }
                        Err(e) if e.kind() != std::io::ErrorKind::NotFound => state = "unavailable",
                        _ => {}
                    }
                }
                result[id] = json!(state);
            }
        }
        Err(_) => {
            for id in ["zcode", "teleagent", "qoder", "kiro"] {
                result[id] = json!("unavailable");
            }
        }
    }
    result
}
fn sql_rows(db: &Connection, query: &str, first: i64) -> Result<Vec<Value>, String> {
    let mut statement = db.prepare(query).map_err(|_| "用量表结构不兼容。")?;
    let names = statement
        .column_names()
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>();
    let rows = statement
        .query_map([first], |r| {
            let mut out = Map::new();
            for (i, key) in names.iter().enumerate() {
                let v = match r.get_ref(i)? {
                    rusqlite::types::ValueRef::Null => Value::Null,
                    rusqlite::types::ValueRef::Integer(n) => json!(n),
                    rusqlite::types::ValueRef::Text(s) => json!(String::from_utf8_lossy(s)),
                    _ => return Err(rusqlite::Error::InvalidQuery),
                };
                out.insert(key.clone(), v);
            }
            Ok(Value::Object(out))
        })
        .map_err(|_| "无法读取用量数据库。")?;
    rows.map(|r| r.map_err(|_| "无法读取用量计数字段。".into()))
        .collect()
}
struct Calls {
    rows: BTreeMap<String, (Row, i64)>,
}
impl Calls {
    fn add(
        &mut self,
        client: &str,
        namespace: &str,
        id: &str,
        session: &str,
        stamp: &Value,
        model: &Value,
        tokens: Option<(Vec<u64>, Vec<String>)>,
        updated: i64,
    ) -> Result<(), String> {
        let (Some(ms), Some((v, unavailable))) = (epoch(stamp), tokens) else {
            return Ok(());
        };
        let date = Utc
            .timestamp_millis_opt(ms)
            .single()
            .ok_or("无效用量时间。")?
            .with_timezone(&chrono::FixedOffset::east_opt(8 * 3600).unwrap())
            .date_naive()
            .to_string();
        if date < model::first() || date > model::today().to_string() {
            return Ok(());
        }
        let key = json!([client, namespace, session, id]).to_string();
        let row = Row {
            date,
            client: client.into(),
            model: model
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or("未标注模型")
                .trim()
                .into(),
            input: v[0],
            output: v[1],
            cache_read: v[2],
            cache_write: v[3],
            reasoning: v[4],
            unavailable,
        };
        if self.rows.get(&key).is_none_or(|(old_row, old)| {
            updated > *old || updated == *old && row.total() >= old_row.total()
        }) {
            self.rows.insert(key, (row, updated));
        }
        Ok(())
    }
}
fn walk(
    root: &Path,
    client: &str,
    calls: &mut Calls,
    seen: &mut BTreeSet<PathBuf>,
) -> Result<(), String> {
    let entries = match fs::read_dir(root) {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("无法读取调用日志目录。".into()),
    };
    for entry in entries {
        let entry = entry.map_err(|_| "无法读取调用日志目录。")?;
        let kind = entry.file_type().map_err(|_| "无法读取调用日志目录。")?;
        if kind.is_dir() {
            walk(&entry.path(), client, calls, seen)?;
        } else if kind.is_file() && entry.path().extension().is_some_and(|e| e == "jsonl") {
            let path = fs::canonicalize(entry.path()).map_err(|_| "无法定位调用日志。")?;
            if !seen.insert(path.clone()) {
                continue;
            }
            let file = fs::File::open(&path).map_err(|_| "无法读取调用日志。")?;
            let mut model = Value::Null;
            let mut session = path.file_stem().unwrap().to_string_lossy().to_string();
            let mut index = 0;
            for line in BufReader::new(file).lines() {
                let line = line.map_err(|_| "无法读取调用日志。")?;
                let Ok(r) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let message = r.get("message").filter(|m| m.is_object()).unwrap_or(&r);
                if let Some(m) = message.get("model").or(r.get("model")) {
                    model = m.clone();
                }
                if let Some(s) = r
                    .get("sessionId")
                    .or(r.get("session_id"))
                    .and_then(Value::as_str)
                {
                    session = s.into();
                }
                if !(r["role"] == "assistant"
                    || r["type"] == "assistant"
                    || message["role"] == "assistant")
                {
                    continue;
                }
                let fallback = format!("turn:{index}");
                index += 1;
                if r["isSidechain"] == true && message["id"].is_null() && r["uuid"].is_null() {
                    continue;
                }
                let id = message
                    .get("id")
                    .or(r.get("uuid"))
                    .or(r.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or(&fallback);
                let usage = message
                    .get("usage")
                    .or(r.get("usage"))
                    .or(r.get("token_usage"))
                    .unwrap_or(&Value::Null);
                let stamp = r
                    .get("timestamp")
                    .or(message.get("timestamp"))
                    .unwrap_or(&Value::Null);
                let namespace = if path.to_string_lossy().contains(".qoder-cn") {
                    "cn"
                } else if client == "qoder" {
                    "intl"
                } else {
                    "zcode"
                };
                calls.add(
                    client,
                    namespace,
                    id,
                    &session,
                    stamp,
                    &model,
                    tokens(
                        usage,
                        if client == "zcode" {
                            "zcode"
                        } else {
                            "qoder-cli"
                        },
                        false,
                    )?,
                    epoch(stamp).unwrap_or(0),
                )?;
            }
        }
    }
    Ok(())
}
fn kiro_files(root: &Path, calls: &mut Calls) -> Result<(), String> {
    let entries = match fs::read_dir(root) {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("无法读取 Kiro 会话目录。".into()),
    };
    for entry in entries {
        let entry = entry.map_err(|_| "无法读取 Kiro 会话目录。")?;
        if !entry
            .file_type()
            .map_err(|_| "无法读取 Kiro 会话。")?
            .is_file()
            || !entry.path().extension().is_some_and(|v| v == "json")
        {
            continue;
        }
        let r: Value =
            serde_json::from_slice(&fs::read(entry.path()).map_err(|_| "无法读取 Kiro 会话。")?)
                .map_err(|_| "Kiro 会话尚未写入完整。")?;
        let state = &r["session_state"];
        let Some(turns) = state["conversation_metadata"]["user_turn_metadatas"].as_array() else {
            continue;
        };
        let session = r["session_id"].as_str().ok_or("Kiro 会话缺少标识。")?;
        for (i, turn) in turns.iter().enumerate() {
            calls.add(
                "kiro",
                "kiro",
                &format!("turn:{i}"),
                session,
                &turn["end_timestamp"],
                &state["rts_model_state"]["model_info"]["model_id"],
                kiro_tokens(turn)?,
                epoch(&turn["end_timestamp"]).unwrap_or(0),
            )?;
        }
    }
    Ok(())
}
pub fn collect(home: &Path, clients: &[String]) -> Result<Vec<Row>, String> {
    let all = paths(home, Some(clients))?;
    let mut calls = Calls {
        rows: BTreeMap::new(),
    };
    let mut seen = BTreeSet::new();
    let first = DateTime::parse_from_rfc3339(&format!("{}T00:00:00+08:00", model::first()))
        .unwrap()
        .timestamp_millis();
    for client in clients {
        let (databases, logs) = all.get(client).ok_or("不支持的本地来源。")?;
        let mut has_db = false;
        for path in databases {
            match fs::metadata(path) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err(format!("{client} 数据库暂不可访问。")),
                Ok(_) => {}
            }
            let canonical = fs::canonicalize(path).map_err(|_| "无法定位用量数据库。")?;
            if !seen.insert(canonical) {
                continue;
            }
            has_db = true;
            let db = Connection::open_with_flags(
                path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .map_err(|_| format!("{client} 用量数据库无法只读打开。"))?;
            db.busy_timeout(Duration::from_secs(1))
                .map_err(|_| "无法设置只读查询。")?;
            db.execute_batch("PRAGMA query_only=ON")
                .map_err(|_| "无法设置只读查询。")?;
            let namespace = if client == "qoder" {
                if path.to_string_lossy().contains("QoderCN") {
                    "cn"
                } else {
                    "intl"
                }
            } else {
                client
            };
            if client == "kiro" {
                // SQL extracts metadata only; never read credentials or message content.
                let query = "SELECT c.conversation_id AS session, CAST(h.key AS TEXT) AS turn,
                    json_extract(c.value,'$.model_info.model_id') AS model,
                    json_extract(h.value,'$.request_metadata') AS meta
                    FROM conversations_v2 c, json_each(c.value,'$.history') h
                    WHERE json_type(h.value,'$.request_metadata')='object'
                    AND CAST(json_extract(h.value,'$.request_metadata.stream_end_timestamp_ms') AS INTEGER)>=?1";
                for r in sql_rows(&db, query, first)? {
                    let m = object(&r["meta"]);
                    calls.add(
                        client,
                        "kiro",
                        r["turn"].as_str().ok_or("Kiro 调用缺少标识。")?,
                        r["session"].as_str().ok_or("Kiro 会话缺少标识。")?,
                        &m["stream_end_timestamp_ms"],
                        &r["model"],
                        kiro_tokens(&m)?,
                        epoch(&m["stream_end_timestamp_ms"]).unwrap_or(0),
                    )?;
                }
            } else if client == "teleagent" {
                for r in sql_rows(&db,"SELECT id,session_id,time_created,time_updated,json_extract(data,'$.modelID') AS model,json_extract(data,'$.tokens') AS tokens,json_extract(data,'$.time.completed') AS completed FROM message WHERE json_extract(data,'$.role')='assistant' AND time_created>=?",first)?{
                    if epoch(&r["completed"]).is_none(){continue;}
                    calls.add(client,namespace,r["id"].as_str().ok_or("调用缺少标识。")?,r["session_id"].as_str().unwrap_or(""),&r["time_created"],&r["model"],tokens(&object(&r["tokens"]),"teleagent",false)?,epoch(&r["time_updated"]).unwrap_or(0))?;
                }
            } else if client == "qoder" {
                for r in sql_rows(&db,"SELECT id,session_id,gmt_create,model_info,token_info FROM chat_message WHERE role='assistant' AND token_info IS NOT NULL AND gmt_create>=?",first)?{
                    let info=object(&r["model_info"]);let model=get(&info,&["model_key","modelKey"]);
                    calls.add(client,namespace,r["id"].as_str().ok_or("调用缺少标识。")?,r["session_id"].as_str().unwrap_or(""),&r["gmt_create"],model,tokens(&object(&r["token_info"]),"qoder-ide",false)?,epoch(&r["gmt_create"]).unwrap_or(0))?;
                }
            } else {
                let columns = db
                    .prepare("PRAGMA table_info(model_usage)")
                    .map_err(|_| "无法读取ZCode表结构。")?
                    .query_map([], |r| r.get::<_, String>(1))
                    .map_err(|_| "无法读取ZCode表结构。")?
                    .collect::<Result<BTreeSet<_>, _>>()
                    .map_err(|_| "无法读取ZCode表结构。")?;
                for key in ["id", "input_tokens", "output_tokens", "started_at"] {
                    if !columns.contains(key) {
                        return Err("ZCode 用量表结构不兼容。".into());
                    }
                }
                let names = [
                    "id",
                    "session_id",
                    "model_id",
                    "started_at",
                    "completed_at",
                    "duration_ms",
                    "input_tokens",
                    "output_tokens",
                    "reasoning_tokens",
                    "cache_read_input_tokens",
                    "cache_creation_input_tokens",
                    "computed_total_tokens",
                ];
                let query = format!(
                    "SELECT {} FROM model_usage WHERE {}>=?{}",
                    names
                        .iter()
                        .map(|n| if columns.contains(*n) {
                            n.to_string()
                        } else {
                            format!("NULL AS {n}")
                        })
                        .collect::<Vec<_>>()
                        .join(","),
                    if columns.contains("completed_at") {
                        "COALESCE(NULLIF(started_at,0),completed_at)"
                    } else {
                        "started_at"
                    },
                    if columns.contains("status") {
                        " AND status='completed'"
                    } else {
                        ""
                    }
                );
                for r in sql_rows(&db, &query, first)? {
                    if !columns.contains("status")
                        && columns.contains("completed_at")
                        && epoch(&r["completed_at"]).is_none()
                    {
                        continue;
                    }
                    let u = json!({"input":r["input_tokens"],"output":r["output_tokens"],"reasoning":r["reasoning_tokens"],"cache_read":r["cache_read_input_tokens"],"cache_write":r["cache_creation_input_tokens"],"total":r["computed_total_tokens"]});
                    let stamp = if epoch(&r["started_at"]).is_some() {
                        &r["started_at"]
                    } else {
                        &r["completed_at"]
                    };
                    calls.add(
                        client,
                        namespace,
                        r["id"].as_str().ok_or("调用缺少标识。")?,
                        r["session_id"].as_str().unwrap_or(""),
                        stamp,
                        &r["model_id"],
                        tokens(&u, "zcode", !columns.contains("computed_total_tokens"))?,
                        epoch(stamp).unwrap_or(0),
                    )?;
                }
            }
        }
        if client == "kiro" {
            if !has_db {
                for root in logs {
                    kiro_files(root, &mut calls)?;
                }
            }
            continue;
        }
        if client == "zcode" && has_db {
            continue;
        }
        for root in logs {
            walk(root, client, &mut calls, &mut seen)?;
        }
    }
    let mut merged: BTreeMap<(String, String, String), Row> = BTreeMap::new();
    for (r, _) in calls.rows.into_values() {
        let key = (r.date.clone(), r.client.clone(), r.model.clone());
        if let Some(old) = merged.get_mut(&key) {
            old.input += r.input;
            old.output += r.output;
            old.cache_read += r.cache_read;
            old.cache_write += r.cache_write;
            old.reasoning += r.reasoning;
            old.unavailable.extend(r.unavailable);
            old.unavailable.sort();
            old.unavailable.dedup();
        } else {
            merged.insert(key, r);
        }
    }
    Ok(merged.into_values().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Value) {
        let home = tempfile::tempdir().unwrap();
        let day = model::today().to_string();
        let iso = format!("{day}T02:00:01Z");
        let epoch = DateTime::parse_from_rfc3339(&iso)
            .unwrap()
            .timestamp_millis()
            .to_string();
        let raw = include_str!("../../../token-usage/tests/fixtures/local-adapters.json")
            .replace("$DAY", &day)
            .replace("$ISO", &iso)
            .replace("\"$MS\"", &epoch)
            .replace("$MS", &epoch);
        let f: Value = serde_json::from_str(&raw).unwrap();
        for db in f["databases"].as_array().unwrap() {
            let path = home.path().join(db["path"].as_str().unwrap());
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let conn = Connection::open(path).unwrap();
            conn.execute_batch(db["schema"].as_str().unwrap()).unwrap();
            for row in db["rows"].as_array().unwrap() {
                let row = row.as_object().unwrap();
                let names = row.keys().cloned().collect::<Vec<_>>();
                let values = row
                    .values()
                    .map(|v| match v {
                        Value::Null => rusqlite::types::Value::Null,
                        Value::Number(n) => rusqlite::types::Value::Integer(n.as_i64().unwrap()),
                        Value::String(s) => rusqlite::types::Value::Text(s.clone()),
                        _ => panic!("invalid fixture"),
                    })
                    .collect::<Vec<_>>();
                conn.execute(
                    &format!(
                        "INSERT INTO {}({}) VALUES({})",
                        db["table"].as_str().unwrap(),
                        names.join(","),
                        vec!["?"; names.len()].join(",")
                    ),
                    rusqlite::params_from_iter(values),
                )
                .unwrap();
            }
        }
        for log in f["logs"].as_array().unwrap() {
            let p = home.path().join(log["path"].as_str().unwrap());
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(
                p,
                log["rows"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|r| r.to_string() + "\n")
                    .collect::<String>()
                    + "{incomplete-tail",
            )
            .unwrap();
        }
        (home, f)
    }
    #[test]
    fn same_corpus_as_javascript_and_private_metadata_only() {
        let (home, f) = fixture();
        let clients = vec![
            "zcode".into(),
            "teleagent".into(),
            "qoder".into(),
            "kiro".into(),
        ];
        let mirrored = home.path().join(".kiro/sessions/cli/mirror.json");
        fs::create_dir_all(mirrored.parent().unwrap()).unwrap();
        fs::write(
            mirrored,
            "{incomplete mirror must not be read when DB exists",
        )
        .unwrap();
        let actual = collect(home.path(), &clients).unwrap();
        let mut expected = serde_json::from_value::<Vec<Row>>(f["expected"].clone()).unwrap();
        expected.sort_by_key(|r| (r.client.clone(), r.model.clone()));
        let mut actual = actual;
        actual.sort_by_key(|r| (r.client.clone(), r.model.clone()));
        assert_eq!(actual, expected);
        assert!(!serde_json::to_string(&actual).unwrap().contains("PRIVATE"));
        let snapshot = model::Snapshot {
            version: 1,
            collector: "club-usage@1".into(),
            captured_at: model::now(),
            rows: actual,
        };
        snapshot.validate().unwrap();
        assert_eq!(detect(home.path())["qoder"], "found");
    }
    #[test]
    fn zcode_text_is_not_token_usage_and_cache_total_is_authoritative() {
        let home = tempfile::tempdir().unwrap();
        let p = home.path().join(".zcode/projects/p/session.jsonl");
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p,format!("{}\n{}\n{}\n",json!({"role":"user","content":"PRIVATE".repeat(100)}),json!({"role":"assistant","content":"PRIVATE".repeat(100)}),json!({"role":"assistant","timestamp":format!("{}T02:00:01Z",model::today()),"model":"glm-fixture","usage":{"input":100,"output":30,"cache_read":20,"cache_write":5,"reasoning":5,"total":130}}))).unwrap();
        let rows = collect(home.path(), &["zcode".into()]).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            (rows[0].input, rows[0].output, rows[0].total()),
            (75, 25, 130)
        );
    }
    #[test]
    fn zcode_completed_status_keeps_ninety_days_without_end_timestamps() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join(".zcode/cli/db/db.sqlite");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE model_usage(id TEXT PRIMARY KEY,session_id TEXT,model_id TEXT,status TEXT,started_at INTEGER,completed_at INTEGER,input_tokens INTEGER,output_tokens INTEGER,computed_total_tokens INTEGER)").unwrap();
        let now = epoch(&json!(format!("{}T02:00:01Z", model::today()))).unwrap();
        for i in 0..91 {
            let time = now - i * 86400000;
            db.execute("INSERT INTO model_usage VALUES(?1,'PRIVATE','zcode-history','completed',?2,?3,100,30,130)",
                rusqlite::params![format!("call-{i}"), time, if i<7 {Some(time)} else {None}]).unwrap();
        }
        for status in [Some("running"), Some("failed"), Some("cancelled"), None] {
            db.execute("INSERT INTO model_usage VALUES(?1,'PRIVATE','zcode-history',?2,?3,?3,1000,300,1300)",
                rusqlite::params![format!("skip-{status:?}"),status,now]).unwrap();
        }
        drop(db);
        let rows = collect(home.path(), &["zcode".into()]).unwrap();
        assert_eq!(rows.len(), 90);
        assert_eq!(rows.iter().map(Row::total).sum::<u64>(), 90 * 130);
        assert_eq!(rows[0].date, model::first());
        assert_eq!(rows.last().unwrap().date, model::today().to_string());
        assert!(!serde_json::to_string(&rows).unwrap().contains("PRIVATE"));
    }
    #[test]
    fn kiro_cli_real_metadata_dedup_and_no_estimation() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join(".kiro/sessions/cli");
        fs::create_dir_all(&root).unwrap();
        let stamp = format!("{}T02:00:01Z", model::today());
        let session = json!({"session_id":"PRIVATE_SESSION","session_state":{
            "rts_model_state":{"model_info":{"model_id":"kiro-cli"}},
            "conversation_metadata":{"user_turn_metadatas":[
                {"end_timestamp":stamp,"input_token_count":80,"output_token_count":30,"cache_read_input_token_count":20,"cache_write_input_token_count":5},
                {"end_timestamp":stamp,"input_token_count":0,"output_token_count":0,"context_usage_percentage":60,"assistant_response_length":9999,"metering_usage":[{"unit":"credit","value":10}]},
                {"end_timestamp":stamp,"input_token_count":7},
                {"input_token_count":900,"output_token_count":900}
            ]}
        }});
        for name in ["s.json", "copy.json"] {
            fs::write(root.join(name), session.to_string()).unwrap();
        }
        fs::write(root.join("s.jsonl"), "PRIVATE_BODY").unwrap();
        let rows = collect(home.path(), &["kiro".into()]).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            (
                rows[0].input,
                rows[0].output,
                rows[0].cache_read,
                rows[0].cache_write,
                rows[0].reasoning
            ),
            (87, 30, 20, 5, 0)
        );
        assert_eq!(
            rows[0].unavailable,
            vec!["cache_read", "cache_write", "output", "reasoning"]
        );
        assert!(!serde_json::to_string(&rows).unwrap().contains("PRIVATE"));
        assert!(kiro_tokens(&json!({"input_tokens":-1})).is_err());
        assert!(kiro_tokens(&json!({"output_tokens":1,"reasoning_tokens":2})).is_err());
        // An incomplete write fails the collection; disabled Kiro is not opened.
        fs::write(root.join("s.json"), "{incomplete").unwrap();
        assert!(collect(home.path(), &["kiro".into()]).is_err());
        assert!(collect(home.path(), &["qoder".into()]).unwrap().is_empty());
    }
    #[test]
    fn qoder_cli_native_totals_and_credits_are_independent() {
        let usage = json!({"input_tokens":100,"output_tokens":30,"cache_read_input_tokens":20,"cache_creation_input_tokens":5});
        let (v, missing) = tokens(&usage, "qoder-cli", false).unwrap().unwrap();
        assert_eq!(v, vec![100, 30, 20, 5, 0]);
        assert_eq!(missing, vec!["reasoning"]);
        let mut credited = usage.clone();
        credited["credits"] = json!(999);
        assert_eq!(
            tokens(&credited, "qoder-cli", false).unwrap(),
            tokens(&usage, "qoder-cli", false).unwrap()
        );
        for (u, expected) in [
            (
                json!({"input_tokens":100,"output_tokens":30,"cache_read_input_tokens":20,"cache_creation_input_tokens":5,"total_tokens":130}),
                vec![75, 30, 20, 5, 0],
            ),
            (
                json!({"input_tokens":100,"output_tokens":30,"cache_read_input_tokens":20,"cache_creation_input_tokens":5,"total_tokens":155}),
                vec![100, 30, 20, 5, 0],
            ),
            (
                json!({"prompt_tokens":100,"completion_tokens":30,"cache_read_input_tokens":20,"cache_creation_input_tokens":5}),
                vec![75, 30, 20, 5, 0],
            ),
            (
                json!({"input_tokens":100,"output_tokens":30,"cache_read_input_tokens":20,"reasoning_tokens":5}),
                vec![100, 25, 20, 0, 5],
            ),
            (
                json!({"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":123}),
                vec![0, 0, 0, 123, 0],
            ),
        ] {
            assert_eq!(tokens(&u, "qoder-cli", false).unwrap().unwrap().0, expected);
        }
        for u in [
            json!({"input":100,"output":30,"cache_read":20}),
            json!({"input":100,"output":30,"cache_read":20,"credits":99}),
        ] {
            assert!(tokens(&u, "qoder-cli", false).is_err());
        }
    }
    #[test]
    fn credits_only_and_unsupported_schema_do_not_fabricate_usage() {
        assert!(tokens(
            &json!({"input_tokens":0,"output_tokens":0,"credits":9}),
            "qoder-cli",
            false
        )
        .unwrap()
        .is_none());
        assert!(tokens(
            &json!({"prompt_tokens":5,"completion_tokens":2,"cache_read_input_tokens":10}),
            "qoder-cli",
            false
        )
        .is_err());
        let home = tempfile::tempdir().unwrap();
        let p = home.path().join(".zcode/cli/db/db.sqlite");
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        Connection::open(p)
            .unwrap()
            .execute_batch("CREATE TABLE unrelated(id)")
            .unwrap();
        assert!(collect(home.path(), &["zcode".into()]).is_err());
    }
}
