// Use the pinned Tokscale Core parser for timestamped Codex and Claude calls.
// The CLI hourly JSON omits the reasoning bucket; aggregate the parsed calls directly.
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::path::PathBuf;
use tokscale_core::{LocalParseOptions, TokenBreakdown};

const HOUR_MS: i64 = 3_600_000;

pub async fn report(home: PathBuf, isolated: bool, sources: Vec<String>) -> Result<Value, String> {
    let now = Utc::now().timestamp_millis();
    let first = (now.div_euclid(HOUR_MS) - 23) * HOUR_MS;
    let mut bins = vec![TokenBreakdown::default(); 24];
    if !sources.is_empty() {
        let options = LocalParseOptions {
            home_dir: Some(home.to_string_lossy().into_owned()),
            use_env_roots: !isolated,
            clients: Some(sources.clone()),
            // Allow a day on either side of the scanner's configured time zone.
            since: DateTime::from_timestamp_millis(first - 24 * HOUR_MS)
                .map(|t| t.date_naive().to_string()),
            ..Default::default()
        };
        let messages = if isolated {
            tokscale_core::parse_local_unified_messages_with_pricing_uncached(options, None).await
        } else {
            tokscale_core::parse_local_unified_messages_with_pricing(options, None).await
        }
        .map_err(|_| "未能读取本机小时记录。")?;
        for message in messages {
            if !(first..=now).contains(&message.timestamp)
                || !sources.contains(&message.client)
                || tokscale_core::recovery::is_daily(&message)
                || tokscale_core::claude_desktop::is_undated_balance(&message)
            {
                continue;
            }
            bins[((message.timestamp - first) / HOUR_MS) as usize]
                .add_assign_saturating(&message.tokens);
        }
    }
    let hours: Vec<_> = bins
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let input = t
                .input
                .saturating_add(t.cache_read)
                .saturating_add(t.cache_write);
            json!({"time": first+i as i64*HOUR_MS, "total": t.total(),
            "rate": if input>0 { Some(t.cache_read as f64/input as f64) } else { None }})
        })
        .collect();
    Ok(json!({"hours":hours,"sources":sources,"ok":true}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn timestamped_codex_counts_reasoning_once_and_weights_cache_by_inputs() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join(".codex/sessions");
        std::fs::create_dir_all(&dir).unwrap();
        let stamp = Utc::now().to_rfc3339();
        let usage = json!({"input_tokens":100,"cached_input_tokens":20,"output_tokens":30,"reasoning_output_tokens":5,"total_tokens":130});
        let event = json!({"timestamp":stamp,"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":usage,"total_token_usage":usage}}});
        let lines = [
            json!({"timestamp":stamp,"type":"session_meta","payload":{"id":"test","timestamp":stamp,"cwd":"/fixture"}}),
            json!({"timestamp":stamp,"type":"turn_context","payload":{"model":"gpt-5"}}),
            event.clone(),
            event,
        ];
        std::fs::write(
            dir.join("rollout-fixture.jsonl"),
            lines.map(|r| r.to_string()).join("\n"),
        )
        .unwrap();
        let report = report(home.path().to_owned(), true, vec!["codex".to_owned()])
            .await
            .unwrap();
        let hours = report["hours"].as_array().unwrap();
        assert_eq!(hours.len(), 24);
        assert_eq!(
            hours
                .iter()
                .map(|r| r["total"].as_i64().unwrap())
                .sum::<i64>(),
            130
        );
        let used = hours.iter().find(|r| r["total"] == 130).unwrap();
        assert_eq!(used["rate"], 0.2);
        assert!(hours
            .iter()
            .filter(|r| r["total"] == 0)
            .all(|r| r["rate"].is_null()));
    }
}
