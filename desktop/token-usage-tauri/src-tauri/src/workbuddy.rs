//! Feed only per-call usage metadata to the pinned native parser. Its SQLite
//! fallback treats context occupancy as usage, so databases must never be staged.
use serde_json::{Map, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::Path,
};

const USAGE_KEYS: &[&str] = &[
    "cachedMissTokens",
    "cacheMissTokens",
    "input_tokens",
    "inputTokens",
    "prompt_tokens",
    "total_tokens",
    "totalTokens",
    "output_tokens",
    "outputTokens",
    "completion_tokens",
    "cache_read_input_tokens",
    "cacheReadInputTokens",
    "cacheTokens",
    "prompt_cache_hit_tokens",
    "cached_tokens",
    "cache_creation_input_tokens",
    "cacheCreationInputTokens",
    "cachedWriteTokens",
    "prompt_cache_write_tokens",
    "completion_thinking_tokens",
    "completionThinkingTokens",
    "reasoningTokens",
];

fn pick(value: &Value, keys: &[&str]) -> Map<String, Value> {
    keys.iter()
        .filter_map(|key| value.get(*key).map(|v| ((*key).into(), v.clone())))
        .collect()
}
fn usage(value: &Value) -> Value {
    Value::Object(
        pick(value, USAGE_KEYS)
            .into_iter()
            .filter(|(_, v)| v.is_i64())
            .collect(),
    )
}
fn metadata(row: &Value, fallback: u64) -> Option<Value> {
    if !(row["type"] == "function_call" || row["type"] == "message" && row["role"] == "assistant") {
        return None;
    }
    let mut clean = pick(row, &["id", "type", "role", "status", "sessionId"]);
    clean.insert(
        "timestamp".into(),
        row.get("timestamp")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or(fallback.into()),
    );
    if let Some(message) = row.get("message").filter(|v| v.is_object()) {
        let mut fields = pick(message, &["model"]);
        if let Some(value) = message.get("usage").filter(|v| !v.is_null()) {
            fields.insert("usage".into(), usage(value));
        }
        clean.insert("message".into(), Value::Object(fields));
    }
    if let Some(provider) = row.get("providerData").filter(|v| v.is_object()) {
        let mut fields = pick(
            provider,
            &["model", "requestModelId", "messageId", "traceId"],
        );
        for key in ["usage", "rawUsage"] {
            if let Some(value) = provider.get(key).filter(|v| !v.is_null()) {
                fields.insert(key.into(), usage(value));
            }
        }
        clean.insert("providerData".into(), Value::Object(fields));
    }
    Some(Value::Object(clean))
}

fn walk(source: &Path, target: &Path) -> std::io::Result<usize> {
    let entries = match fs::read_dir(source) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e),
    };
    let mut count = 0;
    for entry in entries {
        let entry = entry?;
        let kind = entry.file_type()?;
        let destination = target.join(entry.file_name());
        if kind.is_dir() {
            count += walk(&entry.path(), &destination)?;
        } else if kind.is_file() && entry.path().extension().is_some_and(|e| e == "jsonl") {
            let file = fs::File::open(entry.path())?;
            let fallback = file
                .metadata()?
                .modified()?
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            let mut output = None;
            for line in BufReader::new(file).lines() {
                let line = line?;
                let Ok(row) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(clean) = metadata(&row, fallback) {
                    if output.is_none() {
                        fs::create_dir_all(target)?;
                        let mut options = fs::OpenOptions::new();
                        options.write(true).create_new(true);
                        #[cfg(unix)]
                        {
                            use std::os::unix::fs::OpenOptionsExt;
                            options.mode(0o600);
                        }
                        output = Some(std::io::BufWriter::new(options.open(&destination)?));
                    }
                    writeln!(output.as_mut().unwrap(), "{clean}")?;
                    count += 1;
                }
            }
            if let Some(mut file) = output {
                file.flush()?;
            }
        }
    }
    Ok(count)
}

pub fn stage(home: &Path, target: &Path) -> Result<usize, String> {
    let mut count = 0;
    for root in [".workbuddy", ".workbuddy-ai"] {
        count += walk(
            &home.join(root).join("projects"),
            &target.join(root).join("projects"),
        )
        .map_err(|_| "WorkBuddy 调用记录读取失败，已保留原统计。".to_string())?;
    }
    Ok(count)
}
