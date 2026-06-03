//! Declarative extension packages (Phase 1).
//!
//! Extensions live as folders under `{app_local_data}/extensions/<folder>/`,
//! each containing an `artex-extension.json` manifest. This module only reads,
//! writes, and removes those folders — it runs NO extension code. The manifest
//! is returned to the frontend as raw JSON; all schema validation happens in
//! TypeScript (`src/modules/extensions`). Contributions in Phase 1 are purely
//! declarative (themes, snippets), so there is no sandbox concern here.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};

const MANIFEST_FILE: &str = "artex-extension.json";

/// Max bytes for a fetched registry index or remote manifest. Declarative
/// packages are tiny; this caps a hostile/huge response.
const FETCH_CAP: usize = 512 * 1024;

#[derive(Serialize)]
pub struct RawExtension {
    /// Absolute path to the extension folder.
    dir: String,
    /// Folder name (the on-disk identifier; used for uninstall).
    folder: String,
    /// Parsed manifest JSON, or null if missing/invalid.
    manifest: Option<serde_json::Value>,
    /// Per-extension load error so one bad package never breaks the rest.
    error: Option<String>,
}

fn extensions_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let root = dir.join("extensions");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(root)
}

/// Reject folder names that could escape the extensions root.
fn safe_folder(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains("..")
    {
        return Err(format!("unsafe extension id/folder: {name:?}"));
    }
    Ok(trimmed.to_string())
}

/// Map an extension id to a filesystem-safe folder name.
fn folder_from_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Ensure `child` is actually inside `root` (defense in depth vs. traversal).
fn assert_within(root: &Path, child: &Path) -> Result<(), String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let child = child
        .canonicalize()
        .unwrap_or_else(|_| child.to_path_buf());
    if child.starts_with(&root) {
        Ok(())
    } else {
        Err("path escapes extensions directory".to_string())
    }
}

#[tauri::command]
pub fn extensions_dir_path(app: AppHandle) -> Result<String, String> {
    Ok(extensions_root(&app)?.to_string_lossy().to_string())
}

#[tauri::command]
pub fn extensions_list(app: AppHandle) -> Result<Vec<RawExtension>, String> {
    let root = extensions_root(&app)?;
    let mut out = Vec::new();
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let folder = entry.file_name().to_string_lossy().to_string();
        let manifest_path = path.join(MANIFEST_FILE);
        let (manifest, error) = match fs::read_to_string(&manifest_path) {
            Ok(s) => match serde_json::from_str::<serde_json::Value>(&s) {
                Ok(v) => (Some(v), None),
                Err(e) => (None, Some(format!("invalid {MANIFEST_FILE}: {e}"))),
            },
            Err(_) => (None, Some(format!("{MANIFEST_FILE} not found"))),
        };
        out.push(RawExtension {
            dir: path.to_string_lossy().to_string(),
            folder,
            manifest,
            error,
        });
    }
    Ok(out)
}

/// Write (or overwrite) an extension's manifest, creating its folder. Used to
/// install a package programmatically (e.g. the bundled sample) without a
/// native file dialog. `id` becomes the folder name (sanitized).
#[tauri::command]
pub fn extensions_write(app: AppHandle, id: String, manifest: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&manifest)
        .map_err(|e| format!("invalid manifest JSON: {e}"))?;
    let folder = safe_folder(&folder_from_id(&id))?;
    let dir = extensions_root(&app)?.join(&folder);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join(MANIFEST_FILE), manifest).map_err(|e| e.to_string())?;
    Ok(())
}

/// Fetch a remote registry index or extension manifest as text.
///
/// HTTPS-only, no private-network opt-in, size-capped — stricter than
/// `net::ai_http_request` (which allows http + an opt-in private bypass and
/// reads the body unbounded). Reuses net.rs's SSRF hardening (URL validation,
/// IP classification, DNS-rebinding pinning, redirect limits).
#[tauri::command]
pub async fn extensions_fetch_text(url: String) -> Result<String, String> {
    let parsed = crate::modules::net::validate_url(&url, false)?;
    if parsed.scheme() != "https" {
        return Err("only https URLs are allowed".to_string());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "missing host".to_string())?
        .to_string();
    let safe_ips = crate::modules::net::classify_and_collect_safe_ips(&host, false).await?;
    let client = crate::modules::net::build_safe_client(false, &[(host, safe_ips)])?;

    let mut resp = client
        .get(parsed)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("fetch failed: HTTP {}", resp.status().as_u16()));
    }
    if let Some(len) = resp.content_length() {
        if len as usize > FETCH_CAP {
            return Err("response too large".to_string());
        }
    }
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        if buf.len() + chunk.len() > FETCH_CAP {
            return Err("response too large".to_string());
        }
        buf.extend_from_slice(&chunk);
    }
    String::from_utf8(buf).map_err(|_| "response is not valid UTF-8".to_string())
}

/// Remove an installed extension folder by its on-disk folder name.
#[tauri::command]
pub fn extensions_uninstall(app: AppHandle, folder: String) -> Result<(), String> {
    let folder = safe_folder(&folder)?;
    let root = extensions_root(&app)?;
    let dir = root.join(&folder);
    if dir.exists() {
        assert_within(&root, &dir)?;
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}
