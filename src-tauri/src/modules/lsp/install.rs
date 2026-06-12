//! Mason-style language-server installer.
//!
//! Downloads a prebuilt language-server binary into an Arterm-managed directory
//! under `{app_local_data}/language-servers/<serverId>/` and returns its
//! absolute path. The frontend writes that path into the `lspServers` override
//! so the existing `lsp_start` / `resolve_program` flow spawns it unchanged —
//! an absolute path bypasses PATH resolution, so no change to `process.rs` is
//! needed. Downloads reuse net.rs's SSRF-hardened client (HTTPS-only, DNS-
//! rebinding pinning, redirect caps).

use std::fs;
use std::io::Write;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::modules::net;

const MANIFEST_FILE: &str = "arterm-server.json";

/// Hard cap on a downloaded artifact (compressed). rust-analyzer is ~30-60MB;
/// 300MB leaves headroom for larger servers while stopping a runaway response
/// from exhausting disk.
const DOWNLOAD_CAP: u64 = 300 * 1024 * 1024;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    downloaded: u64,
    total: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledServer {
    server_id: String,
    version: String,
    bin_path: String,
}

fn servers_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let root = dir.join("language-servers");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(root)
}

/// Reject ids/names that could escape the managed root.
fn safe_segment(name: &str, kind: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains("..")
    {
        return Err(format!("unsafe {kind}: {name:?}"));
    }
    Ok(trimmed.to_string())
}

/// Defense in depth vs. path traversal: ensure `child` is inside `root`.
fn assert_within(root: &Path, child: &Path) -> Result<(), String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let child = child.canonicalize().unwrap_or_else(|_| child.to_path_buf());
    if child.starts_with(&root) {
        Ok(())
    } else {
        Err("path escapes language-servers directory".to_string())
    }
}

#[tauri::command]
pub fn lsp_install_dir(app: AppHandle) -> Result<String, String> {
    Ok(servers_root(&app)?.to_string_lossy().to_string())
}

#[tauri::command]
pub fn lsp_install_list(app: AppHandle) -> Result<Vec<InstalledServer>, String> {
    let root = servers_root(&app)?;
    let mut out = Vec::new();
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Ok(text) = fs::read_to_string(path.join(MANIFEST_FILE)) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let server_id = value
            .get("serverId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let version = value
            .get("version")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let bin_path = value
            .get("binPath")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        // Skip stale entries whose binary was removed out from under us.
        if server_id.is_empty() || bin_path.is_empty() || !Path::new(&bin_path).exists() {
            continue;
        }
        out.push(InstalledServer {
            server_id,
            version,
            bin_path,
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn lsp_install_uninstall(app: AppHandle, server_id: String) -> Result<(), String> {
    let id = safe_segment(&server_id, "server id")?;
    let root = servers_root(&app)?;
    let dir = root.join(&id);
    if dir.exists() {
        assert_within(&root, &dir)?;
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Download a server artifact, place (and decompress) its binary into the
/// managed dir, write a manifest, and return the binary's absolute path.
#[tauri::command]
pub async fn lsp_install_download(
    app: AppHandle,
    server_id: String,
    url: String,
    archive: String,
    bin_name: String,
    version: String,
    on_progress: Channel<DownloadProgress>,
) -> Result<String, String> {
    let id = safe_segment(&server_id, "server id")?;
    let bin = safe_segment(&bin_name, "binary name")?;

    // GitHub release downloads redirect github.com -> *.githubusercontent.com.
    // net::build_safe_client refuses cross-host redirects when private access
    // is off (SSRF hardening), so we follow redirects manually and re-validate
    // every hop (HTTPS-only, public IP, DNS-rebinding pinning).
    let resp = fetch_following_redirects(&url).await?;
    let total = resp.content_length();
    if let Some(len) = total {
        if len > DOWNLOAD_CAP {
            return Err("server artifact too large".to_string());
        }
    }

    // Stream to a temp file so the whole binary never sits in memory.
    let tmp = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    {
        let mut file = tmp.as_file().try_clone().map_err(|e| e.to_string())?;
        let mut downloaded: u64 = 0;
        let mut stream = resp.bytes_stream();
        while let Some(item) = stream.next().await {
            let chunk = item.map_err(|e| e.to_string())?;
            downloaded += chunk.len() as u64;
            if downloaded > DOWNLOAD_CAP {
                return Err("server artifact too large".to_string());
            }
            file.write_all(&chunk).map_err(|e| e.to_string())?;
            let _ = on_progress.send(DownloadProgress { downloaded, total });
        }
        file.flush().map_err(|e| e.to_string())?;
    }

    let root = servers_root(&app)?;
    let dir = root.join(&id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let bin_path = dir.join(&bin);

    // Decompress/place off the async runtime (blocking fs + inflate).
    let tmp_path = tmp.path().to_path_buf();
    let bin_path_for_blocking = bin_path.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        match archive.as_str() {
            "gz" => {
                let src = fs::File::open(&tmp_path).map_err(|e| e.to_string())?;
                let mut decoder = flate2::read::GzDecoder::new(src);
                let mut out =
                    fs::File::create(&bin_path_for_blocking).map_err(|e| e.to_string())?;
                std::io::copy(&mut decoder, &mut out).map_err(|e| e.to_string())?;
            }
            "zip" => {
                // rust-analyzer's Windows zip holds a single `rust-analyzer.exe`.
                // Extract the first regular file into our own bin_path (so the
                // entry's internal name can't cause a path-traversal write).
                let file = fs::File::open(&tmp_path).map_err(|e| e.to_string())?;
                let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
                let mut wrote = false;
                for i in 0..archive.len() {
                    let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
                    if entry.is_dir() {
                        continue;
                    }
                    let mut out =
                        fs::File::create(&bin_path_for_blocking).map_err(|e| e.to_string())?;
                    std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
                    wrote = true;
                    break;
                }
                if !wrote {
                    return Err("zip archive contained no file".to_string());
                }
            }
            "none" => {
                fs::copy(&tmp_path, &bin_path_for_blocking).map_err(|e| e.to_string())?;
            }
            other => return Err(format!("unsupported archive type: {other}")),
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&bin_path_for_blocking)
                .map_err(|e| e.to_string())?
                .permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&bin_path_for_blocking, perms).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;
    drop(tmp); // delete the temp artifact now that the binary is placed

    let installed_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let manifest = serde_json::json!({
        "serverId": id,
        "version": version,
        "binPath": bin_path.to_string_lossy(),
        "installedAt": installed_at,
    });
    fs::write(dir.join(MANIFEST_FILE), manifest.to_string()).map_err(|e| e.to_string())?;

    log::info!("lsp install: {id} -> {}", bin_path.to_string_lossy());
    Ok(bin_path.to_string_lossy().to_string())
}

/// Follow up to 6 HTTP redirects manually, re-validating every hop for SSRF
/// (HTTPS-only, non-metadata public host, DNS-rebinding pinning), and return
/// the final 2xx response ready to stream. We can't use net::build_safe_client
/// here: it rejects the cross-host redirect that GitHub release downloads
/// require (github.com -> *.githubusercontent.com) when private access is off.
async fn fetch_following_redirects(start_url: &str) -> Result<reqwest::Response, String> {
    let mut url = start_url.to_string();
    for _hop in 0..6 {
        let parsed = net::validate_url(&url, false)?;
        if parsed.scheme() != "https" {
            return Err("only https URLs are allowed".to_string());
        }
        let host = parsed
            .host_str()
            .ok_or_else(|| "missing host".to_string())?
            .to_string();
        let safe_ips = net::classify_and_collect_safe_ips(&host, false).await?;
        let addrs: Vec<SocketAddr> = safe_ips.iter().map(|ip| SocketAddr::new(*ip, 0)).collect();
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .resolve_to_addrs(&host, &addrs)
            .build()
            .map_err(|e| e.to_string())?;

        let resp = client
            .get(parsed)
            .timeout(Duration::from_secs(300))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        if status.is_redirection() {
            let location = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| "redirect without location".to_string())?;
            url = resp
                .url()
                .join(location)
                .map_err(|e| e.to_string())?
                .to_string();
            continue;
        }
        if !status.is_success() {
            return Err(format!("download failed: HTTP {}", status.as_u16()));
        }
        return Ok(resp);
    }
    Err("too many redirects".to_string())
}
