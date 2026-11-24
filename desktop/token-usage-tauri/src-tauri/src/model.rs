use chrono::{Duration, FixedOffset, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

pub use crate::source_catalog::CLIENTS;
use crate::source_catalog::DEFAULT_CLIENTS;
pub const SITE: &str = "https://changzhouai.club";
pub fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub fn today() -> NaiveDate {
    Utc::now()
        .with_timezone(&FixedOffset::east_opt(8 * 3600).unwrap())
        .date_naive()
}
pub fn first() -> String {
    (today() - Duration::days(89)).to_string()
}
pub fn defaults() -> BTreeMap<String, bool> {
    CLIENTS
        .iter()
        .map(|c| (c.to_string(), DEFAULT_CLIENTS.contains(c)))
        .collect()
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Row {
    pub date: String,
    pub client: String,
    pub model: String,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub reasoning: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unavailable: Vec<String>,
}
impl Row {
    pub fn total(&self) -> u64 {
        self.input + self.output + self.cache_read + self.cache_write + self.reasoning
    }
    fn valid(&self) -> bool {
        let date = NaiveDate::parse_from_str(&self.date, "%Y-%m-%d");
        date.is_ok_and(|d| d.to_string() == self.date)
            && self.date >= first()
            && self.date <= today().to_string()
            && CLIENTS.contains(&self.client.as_str())
            && self.unavailable.len() <= 5
            && self.unavailable.iter().all(|f| {
                ["input", "output", "cache_read", "cache_write", "reasoning"].contains(&f.as_str())
            })
            && self.unavailable.iter().collect::<BTreeSet<_>>().len() == self.unavailable.len()
            && !self.model.trim().is_empty()
            && self.model.encode_utf16().count() <= 120
            && [
                self.input,
                self.output,
                self.cache_read,
                self.cache_write,
                self.reasoning,
            ]
            .iter()
            .all(|n| *n <= 1_000_000_000_000)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub version: u32,
    pub collector: String,
    pub captured_at: String,
    pub rows: Vec<Row>,
}
impl Snapshot {
    pub fn validate(&self) -> Result<(), String> {
        let mut keys = BTreeSet::new();
        if self.version != 1
            || ![
                "tokscale@4.17.0",
                "tokscale@4.20.1",
                "tokscale@4.23.1",
                "club-usage@1",
            ]
            .contains(&self.collector.as_str())
            || self.rows.len() > 5000
            || chrono::DateTime::parse_from_rfc3339(&self.captured_at).is_err()
        {
            return Err("本机统计格式无效，请重新读取。".into());
        }
        let mut total = 0u64;
        for row in &self.rows {
            if !row.valid() || !keys.insert((&row.date, &row.client, &row.model)) {
                return Err("本机统计含无效日期、来源、数量或重复记录。".into());
            }
            total = total
                .checked_add(row.total())
                .ok_or("Token 数量超出限制。")?;
        }
        if total > 1_000_000_000_000 {
            return Err("Token 数量超出内测限制。".into());
        }
        Ok(())
    }
}

pub fn normalize_graph(graph: Value) -> Result<Snapshot, String> {
    if graph["meta"]["version"] != "4.23.1" {
        return Err("采集器版本不匹配。".into());
    }
    let mut merged: BTreeMap<(String, String, String), Row> = BTreeMap::new();
    let days = graph["contributions"]
        .as_array()
        .ok_or("采集结果格式无效。")?;
    for day in days {
        let date = day["date"].as_str().ok_or("缺少统计日期。")?;
        for source in day["clients"].as_array().ok_or("缺少来源统计。")? {
            let client = match source["client"].as_str().ok_or("缺少来源。")? {
                "antigravity-cli" | "antigravity-extension" => "antigravity",
                id => id,
            };
            let model = source["modelId"].as_str().ok_or("缺少模型。")?.trim();
            let count = |key: &str| {
                source["tokens"][key]
                    .as_u64()
                    .filter(|n| *n <= 1_000_000_000_000)
                    .ok_or_else(|| "异常 Token 数量。".to_string())
            };
            let row = Row {
                date: date.into(),
                client: client.into(),
                model: model.into(),
                input: count("input")?,
                output: count("output")?,
                cache_read: count("cacheRead")?,
                cache_write: count("cacheWrite")?,
                reasoning: count("reasoning")?,
                unavailable: vec![],
            };
            if !row.valid() {
                return Err("采集结果包含异常统计。".into());
            }
            let key = (row.date.clone(), row.client.clone(), row.model.clone());
            if let Some(old) = merged.get_mut(&key) {
                old.input += row.input;
                old.output += row.output;
                old.cache_read += row.cache_read;
                old.cache_write += row.cache_write;
                old.reasoning += row.reasoning;
                if !old.valid() {
                    return Err("单日统计超出限制。".into());
                }
            } else {
                merged.insert(key, row);
            }
            if merged.len() > 5000 {
                return Err("统计条目超出限制。".into());
            }
        }
    }
    let snapshot = Snapshot {
        version: 1,
        collector: "tokscale@4.23.1".into(),
        captured_at: now(),
        rows: merged.into_values().collect(),
    };
    snapshot.validate()?;
    Ok(snapshot)
}

pub fn validate_site(value: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(value).map_err(|_| "社区地址无效。")?;
    let local = ["127.0.0.1", "localhost", "[::1]"].contains(&url.host_str().unwrap_or(""));
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
        || !(url.scheme() == "https" || url.scheme() == "http" && local)
        || url.host_str().is_none()
    {
        return Err("请输入 HTTPS 社区根地址（本机测试可使用 HTTP）。".into());
    }
    Ok(url.origin().ascii_serialization())
}

pub fn safe_avatar_url(value: &str) -> String {
    if value.len() > 2048 {
        return String::new();
    }
    match tauri::Url::parse(value) {
        Ok(u) if u.scheme() == "https" && u.username().is_empty() && u.password().is_none() => {
            u.to_string()
        }
        _ => String::new(),
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub site: String,
    pub nickname: String,
    pub avatar_url: String,
    pub enabled: bool,
    pub sources: BTreeMap<String, bool>,
    pub snapshot: Option<Snapshot>,
    pub last_collected_at: Option<String>,
    pub last_synced_at: Option<String>,
    pub pending_upload: bool,
    pub sources_changed: bool,
    pub source_status: Value,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            site: SITE.into(),
            nickname: String::new(),
            avatar_url: String::new(),
            enabled: true,
            sources: defaults(),
            snapshot: None,
            last_collected_at: None,
            last_synced_at: None,
            pending_upload: false,
            sources_changed: false,
            source_status: json!({}),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn graph(client: &str) -> Value {
        json!({"meta":{"version":"4.23.1"},"contributions":[{"date":today().to_string(),"clients":[{"client":client,"modelId":"model","tokens":{"input":100,"output":30,"cacheRead":20,"cacheWrite":0,"reasoning":5},"prompt":"PRIVATE"}]}]})
    }
    #[test]
    fn buckets_and_privacy() {
        let s = normalize_graph(graph("qwen")).unwrap();
        assert_eq!(s.rows[0].total(), 155);
        assert_eq!(s.rows[0].input, 100);
        assert_eq!(s.rows[0].output, 30);
        assert!(!serde_json::to_string(&s).unwrap().contains("PRIVATE"));
    }
    #[test]
    fn catalog_sources() {
        for c in CLIENTS {
            normalize_graph(graph(c)).unwrap();
        }
        for client in ["antigravity-cli", "antigravity-extension"] {
            assert_eq!(
                normalize_graph(graph(client)).unwrap().rows[0].client,
                "antigravity"
            );
        }
        assert!(normalize_graph(graph("unknown")).is_err());
    }
    #[test]
    fn invalid_counts() {
        let mut g = graph("qwen");
        g["contributions"][0]["clients"][0]["tokens"]["input"] = json!(1);
        assert_eq!(normalize_graph(g).unwrap().rows[0].input, 1);
        let mut g = graph("codex");
        g["contributions"][0]["clients"][0]["tokens"]["input"] = json!(-1);
        assert!(normalize_graph(g).is_err());
    }
    #[test]
    fn duplicate_provider_rows_merge() {
        let mut g = graph("codex");
        let second = g["contributions"][0]["clients"][0].clone();
        g["contributions"][0]["clients"]
            .as_array_mut()
            .unwrap()
            .push(second);
        let s = normalize_graph(g).unwrap();
        assert_eq!(s.rows.len(), 1);
        assert_eq!(s.rows[0].input, 200);
    }
    #[test]
    fn urls_are_roots_and_safe() {
        for u in [
            "http://evil.com",
            "https://user:pass@a.com",
            "https://a.com/path",
            "https://a.com?x=1",
            "file:///tmp",
        ] {
            assert!(validate_site(u).is_err(), "{u}");
        }
        assert!(validate_site("http://127.0.0.1:3107").is_ok());
        assert_eq!(validate_site(SITE).unwrap(), SITE);
    }
    #[test]
    fn avatar_urls_are_https_and_old_settings_still_load() {
        for value in [
            "file:///private/a.png",
            "http://example.com/a.png",
            "javascript:alert(1)",
            "https://user:secret@example.com/a.png",
        ] {
            assert!(safe_avatar_url(value).is_empty());
        }
        assert_eq!(
            safe_avatar_url("https://example.com/a.png"),
            "https://example.com/a.png"
        );
        let s: Settings = serde_json::from_value(json!({"nickname":"old"})).unwrap();
        assert!(s.avatar_url.is_empty());
    }
    #[test]
    fn settings_never_persist_legacy_credential() {
        let s: Settings =
            serde_json::from_value(json!({"credential":"SECRET","token":"PLAINTEXT"})).unwrap();
        let result = serde_json::to_string(&s).unwrap();
        assert!(!result.contains("SECRET"));
        assert!(!result.contains("PLAINTEXT"));
    }
}
