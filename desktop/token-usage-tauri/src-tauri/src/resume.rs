// The release URL and signature identify immutable bytes across restarts.
use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use reqwest::{header, Client, StatusCode};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::Path, time::Duration};

const LIMIT: u64 = 512 * 1024 * 1024;
const NET: &str = "下载中断，已保留进度。联网后点击「继续更新」。";
const DISK: &str = "无法保存更新包，请检查磁盘空间和写入权限。";
const INVALID: &str = "更新包校验失败，已清除该下载，请重新检查更新。";

fn verify(bytes: &[u8], signature: &str, key: &str, version: &str) -> Option<()> {
    let decode = |s| String::from_utf8(STANDARD.decode(s).ok()?).ok();
    let key = PublicKey::decode(&decode(key)?).ok()?;
    let sig = Signature::decode(&decode(signature)?).ok()?;
    key.verify(bytes, &sig, true).ok()?;
    if let Some(v) = sig
        .trusted_comment()
        .split('\t')
        .find_map(|s| s.strip_prefix("version:"))
    {
        if v.trim_start_matches('v') != version.trim_start_matches('v') {
            return None;
        }
    }
    Some(())
}

fn content_range(value: &str, offset: u64) -> Option<u64> {
    let (range, total) = value.strip_prefix("bytes ")?.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let total = total.parse::<u64>().ok()?;
    (start.parse::<u64>().ok()? == offset
        && end.parse::<u64>().ok()?.checked_add(1)? == total
        && offset < total
        && total <= LIMIT)
        .then_some(total)
}

pub async fn download(
    dir: &Path,
    url: &str,
    signature: &str,
    key: &str,
    version: &str,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<Vec<u8>, &'static str> {
    fs::create_dir_all(dir).map_err(|_| DISK)?;
    let id = format!("{:x}", Sha256::digest(format!("{url}\n{signature}")));
    let path = dir.join(format!("{id}.part"));
    // This directory is private to the updater and only one update can run at a time.
    for entry in fs::read_dir(dir).map_err(|_| DISK)?.flatten() {
        let other = entry.path();
        if other != path && other.extension().is_some_and(|ext| ext == "part") {
            let _ = fs::remove_file(other);
        }
    }
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|_| NET)?;
    let mut offset = match fs::metadata(&path) {
        Ok(m) => m.len(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
        Err(_) => return Err(DISK),
    };
    let verified = || {
        let bytes = fs::read(&path).map_err(|_| DISK)?;
        if verify(&bytes, signature, key, version).is_none() {
            fs::remove_file(&path).map_err(|_| DISK)?;
            return Err(INVALID);
        }
        Ok(bytes)
    };
    if offset > LIMIT {
        fs::remove_file(&path).map_err(|_| DISK)?;
        offset = 0;
    }
    progress(offset, None);
    let mut request = client.get(url).header(header::ACCEPT_ENCODING, "identity");
    if offset > 0 {
        request = request.header(header::RANGE, format!("bytes={offset}-"));
    }
    let mut response = request.send().await.map_err(|_| NET)?;
    if response.status() == StatusCode::RANGE_NOT_SATISFIABLE && offset > 0 {
        return verified();
    }
    let total = match response.status() {
        StatusCode::PARTIAL_CONTENT => Some(
            response
                .headers()
                .get(header::CONTENT_RANGE)
                .and_then(|h| h.to_str().ok())
                .and_then(|v| content_range(v, offset))
                .ok_or("下载服务器返回的续传位置异常，请稍后重试。")?,
        ),
        StatusCode::OK => {
            offset = 0;
            response.content_length()
        }
        _ => return Err(NET),
    };
    if total.is_some_and(|v| v > LIMIT) {
        return Err(INVALID);
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(offset > 0)
        .truncate(offset == 0)
        .open(&path)
        .map_err(|_| DISK)?;
    progress(offset, total);
    let mut synced = offset;
    while let Some(chunk) = response.chunk().await.map_err(|_| NET)? {
        if offset + chunk.len() as u64 > total.unwrap_or(LIMIT) {
            return Err("更新包大小异常，请重新检查更新。");
        }
        file.write_all(&chunk).map_err(|_| DISK)?;
        offset += chunk.len() as u64;
        if offset - synced >= 1024 * 1024 {
            file.sync_data().map_err(|_| DISK)?;
            synced = offset;
        }
        progress(offset, total);
    }
    file.sync_all().map_err(|_| DISK)?;
    drop(file);
    if total.is_some_and(|v| v != offset) {
        return Err(NET);
    }
    verified()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;
    const BODY: &[u8] = include_bytes!("../tests/fixtures/update.bin");
    const SIG: &str = include_str!("../tests/fixtures/update.bin.sig");
    const KEY: &str = include_str!("../tests/fixtures/update.pub");

    #[tokio::test]
    async fn interrupted_download_resumes_from_disk_and_verifies() {
        for honors_range in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            let server = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/release", server.local_addr().unwrap());
            let worker = std::thread::spawn(move || {
                for attempt in 0..2 {
                    let (mut stream, _) = server.accept().unwrap();
                    let mut request = [0u8; 4096];
                    let n = stream.read(&mut request).unwrap();
                    if attempt == 1 {
                        assert!(String::from_utf8_lossy(&request[..n])
                            .to_lowercase()
                            .contains("range: bytes=20-"));
                    }
                    if attempt == 1 && honors_range {
                        write!(stream,"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 20-{}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", BODY.len()-1,BODY.len(),BODY.len()-20).unwrap();
                        stream.write_all(&BODY[20..]).unwrap();
                    } else {
                        write!(
                            stream,
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            BODY.len()
                        )
                        .unwrap();
                        stream
                            .write_all(if attempt == 0 { &BODY[..20] } else { BODY })
                            .unwrap();
                        if attempt == 0 {
                            std::thread::sleep(Duration::from_millis(50));
                        }
                    }
                }
            });
            assert!(
                download(dir.path(), &url, SIG.trim(), KEY.trim(), "1.0.0", |_, _| {})
                    .await
                    .is_err()
            );
            // A fresh invocation has no state other than the bytes on disk.
            let data = download(dir.path(), &url, SIG.trim(), KEY.trim(), "1.0.0", |_, _| {})
                .await
                .unwrap();
            assert_eq!(data, BODY);
            worker.join().unwrap();
        }
        assert!(verify(&BODY[1..], SIG.trim(), KEY.trim(), "1.0.0").is_none());
    }
}
