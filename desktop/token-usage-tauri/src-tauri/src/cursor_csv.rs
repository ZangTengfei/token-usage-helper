use crate::model::{self, Row, Snapshot};
use chrono::{DateTime, FixedOffset, NaiveDate, Utc};
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::Path};

const DB_ERROR: &str = "无法读写本机 Cursor 导入记录。";
const LIMIT: u64 = 1_000_000_000_000;

fn merge(db: &Connection, snapshot: &mut Snapshot) -> Result<(), String> {
    let mut query = db.prepare("SELECT day, model, sum(input*n), sum(output*n), sum(cr*n), sum(cw*n) FROM events WHERE day BETWEEN ?1 AND ?2 GROUP BY day,model ORDER BY day,model").map_err(|_| DB_ERROR)?;
    let rows = query
        .query_map(params![model::first(), model::today().to_string()], |r| {
            Ok(Row {
                date: r.get(0)?,
                client: "cursor".into(),
                model: r.get(1)?,
                input: r.get(2)?,
                output: r.get(3)?,
                cache_read: r.get(4)?,
                cache_write: r.get(5)?,
                reasoning: 0,
                unavailable: vec!["reasoning".into()],
            })
        })
        .map_err(|_| DB_ERROR)?;
    snapshot.rows.retain(|r| r.client != "cursor");
    for row in rows {
        snapshot.rows.push(row.map_err(|_| DB_ERROR)?);
    }
    snapshot.collector = "club-usage@1".into();
    snapshot.validate()
}

pub fn restore(path: &Path, snapshot: &mut Snapshot) -> Result<(), String> {
    if path.try_exists().map_err(|_| DB_ERROR)? {
        let db = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|_| DB_ERROR)?;
        merge(&db, snapshot)?;
    }
    Ok(())
}

pub fn import(path: &Path, content: &str, snapshot: &mut Snapshot) -> Result<String, String> {
    if content.len() > 32 * 1024 * 1024 {
        return Err("CSV 超过 32 MB，请缩小导出日期范围。".into());
    }
    let mut reader = csv::ReaderBuilder::new()
        .trim(csv::Trim::All)
        .from_reader(content.as_bytes());
    let headers = reader.headers().map_err(|_| "无法读取 CSV 表头。")?;
    let col = |name: &str| {
        headers
            .iter()
            .position(|h| h.eq_ignore_ascii_case(name))
            .ok_or_else(|| format!("Cursor CSV 缺少 {name} 列。"))
    };
    let date = col("Date")?;
    let model_col = col("Model")?;
    let fields = [
        col("Input (w/o Cache Write)")?,
        col("Output Tokens")?,
        col("Cache Read")?,
        col("Input (w/ Cache Write)")?,
    ];
    let first = model::first();
    let today = model::today().to_string();
    let mut db = Connection::open(path).map_err(|_| DB_ERROR)?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS events (key BLOB PRIMARY KEY, day TEXT NOT NULL, model TEXT NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, cr INTEGER NOT NULL, cw INTEGER NOT NULL, n INTEGER NOT NULL) WITHOUT ROWID").map_err(|_| DB_ERROR)?;
    let tx = db.transaction().map_err(|_| DB_ERROR)?;
    tx.execute("DELETE FROM events WHERE day < ?1", [&first])
        .map_err(|_| DB_ERROR)?;
    let mut seen = HashMap::new();
    let (mut added, mut duplicates, mut skipped) = (0, 0, 0);
    {
        let mut insert = tx.prepare("INSERT INTO events VALUES (?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(key) DO UPDATE SET n=excluded.n WHERE events.n < excluded.n").map_err(|_| DB_ERROR)?;
        for (i, record) in reader.records().enumerate() {
            let invalid = || format!("CSV 第 {} 条记录格式无效。", i + 1);
            let r = record.map_err(|_| invalid())?;
            let (day, stamp) = if let Ok(t) = DateTime::parse_from_rfc3339(&r[date]) {
                (
                    t.with_timezone(&FixedOffset::east_opt(8 * 3600).unwrap())
                        .date_naive()
                        .to_string(),
                    t.with_timezone(&Utc).to_rfc3339(),
                )
            } else {
                let day = NaiveDate::parse_from_str(&r[date], "%Y-%m-%d")
                    .map_err(|_| invalid())?
                    .to_string();
                (day.clone(), day)
            };
            if day < first || day > today {
                skipped += 1;
                continue;
            }
            let name = &r[model_col];
            let mut counts = [0u64; 4];
            for (n, col) in counts.iter_mut().zip(fields) {
                let field = &r[col];
                if !field.is_empty() {
                    *n = field
                        .parse::<u64>()
                        .ok()
                        .filter(|n| *n <= LIMIT)
                        .ok_or_else(invalid)?;
                }
            }
            if counts == [0; 4] {
                skipped += 1;
                continue;
            }
            if name.is_empty() || name.encode_utf16().count() > 120 {
                return Err(invalid());
            }
            // Use the maximum multiplicity across exports, preserving identical calls within one export.
            let key = Sha256::digest(serde_json::to_vec(&(stamp, name, counts)).unwrap()).to_vec();
            let n = seen.entry(key.clone()).or_insert(0i64);
            *n += 1;
            let changes = insert
                .execute(params![
                    key, day, name, counts[0], counts[1], counts[2], counts[3], *n
                ])
                .map_err(|_| DB_ERROR)?;
            added += changes;
            duplicates += 1 - changes;
        }
    }
    if added + duplicates == 0 {
        return Err("CSV 中没有最近 90 天的非零 Token 记录。".into());
    }
    merge(&tx, snapshot)?;
    tx.commit().map_err(|_| DB_ERROR)?;
    Ok(format!(
        "Cursor 导入完成：新增 {added} 条，重复 {duplicates} 条，跳过 {skipped} 条。"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    const HEADER: &str = "Date,Kind,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost";
    fn empty() -> Snapshot {
        Snapshot {
            version: 1,
            collector: "club-usage@1".into(),
            captured_at: model::now(),
            rows: vec![],
        }
    }
    #[test]
    fn repeated_and_overlapping_exports_survive_restart_and_preserve_multiplicity() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("cursor.sqlite3");
        let yesterday = model::today().pred_opt().unwrap();
        let a = format!("{yesterday}T17:00:00Z,Included,\"model,x\",4,3,2,1,10,0.01");
        let b = a.replace("17:00:00", "18:00:00");
        let csv = format!("\u{feff}{HEADER}\r\n{a}\r\n{a}");
        let mut snapshot = empty();
        assert!(import(&db, &csv, &mut snapshot)
            .unwrap()
            .contains("新增 2 条"));
        let row = &snapshot.rows[0];
        assert_eq!(
            (
                row.date.clone(),
                row.input,
                row.output,
                row.cache_read,
                row.cache_write
            ),
            (model::today().to_string(), 6, 2, 4, 8)
        );
        assert!(import(&db, &csv, &mut snapshot)
            .unwrap()
            .contains("新增 0 条，重复 2 条"));
        let overlap = format!(
            "{HEADER}\n{b}\n{}",
            a.replace("17:00:00Z", "17:00:00.000+00:00")
        );
        assert!(import(&db, &overlap, &mut snapshot)
            .unwrap()
            .contains("新增 1 条，重复 1 条"));
        // A valid new event followed by a malformed one must roll back the entire import.
        assert!(import(
            &db,
            &format!(
                "{HEADER}\n{}\n{}",
                a.replace("17:00:00", "19:00:00"),
                a.replace(",3,", ",-1,")
            ),
            &mut snapshot
        )
        .is_err());
        let mut reloaded = empty();
        restore(&db, &mut reloaded).unwrap();
        assert_eq!(reloaded.rows, snapshot.rows);
        assert_eq!(reloaded.rows[0].total(), 30);
    }
}
