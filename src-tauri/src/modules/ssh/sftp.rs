//! SFTP operations layered over an existing SSH connection. The SFTP subsystem
//! runs on its own channel, so file transfers never contend with an interactive
//! shell on the same connection.

use std::path::Path;

use russh::client::Handle;
use russh_sftp::client::SftpSession;
use serde::Serialize;
use tokio::io::AsyncWriteExt;

use super::session::Client;
use crate::modules::pty::session::EventSink;

fn to_json<T: Serialize>(value: T) -> serde_json::Value {
    serde_json::to_value(value).unwrap_or(serde_json::Value::Null)
}

/// Cap for opening a remote file into the editor. Matches the local fs read
/// cap; without it a multi-GB (or hostile) remote file is slurped fully into
/// memory and OOMs the app.
const MAX_READ_TEXT_BYTES: u64 = 10 * 1024 * 1024;

/// Open the SFTP subsystem on a fresh channel of an authenticated connection.
pub async fn open_sftp(handle: &Handle<Client>) -> Result<SftpSession, String> {
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("sftp channel open failed: {e}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("sftp subsystem request failed: {e}"))?;
    SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("sftp init failed: {e}"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    pub name: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
}

pub async fn list(sftp: &SftpSession, path: &str) -> Result<Vec<SftpEntry>, String> {
    let dir = sftp
        .read_dir(path)
        .await
        .map_err(|e| format!("read_dir failed: {e}"))?;
    let mut out: Vec<SftpEntry> = dir
        .map(|entry| {
            let ft = entry.file_type();
            SftpEntry {
                name: entry.file_name(),
                is_dir: ft.is_dir(),
                is_symlink: ft.is_symlink(),
                size: entry.metadata().len(),
            }
        })
        .filter(|e| e.name != "." && e.name != "..")
        .collect();
    // Directories first, then case-insensitive by name — matches the local tree.
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

pub async fn read_text(sftp: &SftpSession, path: &str) -> Result<String, String> {
    // Reject oversized files up front (the server reports the size) so a huge
    // or hostile remote file can't be read fully into memory.
    let meta = sftp
        .metadata(path)
        .await
        .map_err(|e| format!("stat failed: {e}"))?;
    if meta.len() > MAX_READ_TEXT_BYTES {
        return Err(format!(
            "file too large to open ({} bytes; limit {MAX_READ_TEXT_BYTES} bytes)",
            meta.len()
        ));
    }
    let bytes = sftp
        .read(path)
        .await
        .map_err(|e| format!("read failed: {e}"))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Write bytes to a remote path, creating/truncating it. `SftpSession::write`
/// opens with WRITE only (no CREATE/TRUNCATE) — a new file fails with "No such
/// file" and an overwrite with shorter data leaves stale trailing bytes. `create`
/// opens CREATE|TRUNCATE|WRITE, which is what we want for both upload and save.
async fn write_bytes(sftp: &SftpSession, remote: &str, bytes: &[u8]) -> Result<(), String> {
    let mut file = sftp
        .create(remote)
        .await
        .map_err(|e| format!("open failed: {e}"))?;
    file.write_all(bytes)
        .await
        .map_err(|e| format!("write failed: {e}"))?;
    file.shutdown()
        .await
        .map_err(|e| format!("close failed: {e}"))
}

pub async fn write_text(sftp: &SftpSession, path: &str, contents: &str) -> Result<(), String> {
    write_bytes(sftp, path, contents.as_bytes()).await
}

/// Stream a remote file down to a local path, creating parent dirs as needed.
pub async fn download(sftp: &SftpSession, remote: &str, local: &str) -> Result<(), String> {
    let bytes = sftp
        .read(remote)
        .await
        .map_err(|e| format!("download read failed: {e}"))?;
    if let Some(parent) = Path::new(local).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create local dir failed: {e}"))?;
    }
    std::fs::write(local, bytes).map_err(|e| format!("download write failed: {e}"))
}

/// Join a remote (POSIX) path with a child name.
fn remote_join(base: &str, name: &str) -> String {
    if base.ends_with('/') {
        format!("{base}{name}")
    } else {
        format!("{base}/{name}")
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub op_id: u32,
    pub done: u64,
    pub failed: u64,
    pub current: String,
    pub finished: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSummary {
    pub downloaded: u64,
    pub failed: u64,
}

/// Recursively download a remote directory tree into `local`, recreating the
/// folder structure and emitting an `ssh-sftp-progress` event per file. Symlinks
/// are skipped (loop/escape safety) and per-item failures are counted and
/// skipped rather than aborting the whole transfer — a remote file whose name is
/// illegal on the host (e.g. `:` on Windows) shouldn't kill the rest.
pub async fn download_dir(
    emit: &EventSink,
    op_id: u32,
    sftp: &SftpSession,
    remote: &str,
    local: &str,
) -> Result<DownloadSummary, String> {
    let mut done: u64 = 0;
    let mut failed: u64 = 0;
    download_dir_inner(emit, op_id, sftp, remote, local, &mut done, &mut failed).await?;
    emit(
        "ssh-sftp-progress",
        to_json(DownloadProgress {
            op_id,
            done,
            failed,
            current: String::new(),
            finished: true,
        }),
    );
    Ok(DownloadSummary {
        downloaded: done,
        failed,
    })
}

async fn download_dir_inner(
    emit: &EventSink,
    op_id: u32,
    sftp: &SftpSession,
    remote: &str,
    local: &str,
    done: &mut u64,
    failed: &mut u64,
) -> Result<(), String> {
    std::fs::create_dir_all(local)
        .map_err(|e| format!("create local dir failed: {e}"))?;
    for entry in list(sftp, remote).await? {
        if entry.is_symlink {
            continue;
        }
        let remote_child = remote_join(remote, &entry.name);
        let local_child = Path::new(local)
            .join(&entry.name)
            .to_string_lossy()
            .into_owned();
        if entry.is_dir {
            // Box the recursive future: async fns can't recurse directly.
            if let Err(e) =
                Box::pin(download_dir_inner(emit, op_id, sftp, &remote_child, &local_child, done, failed))
                    .await
            {
                eprintln!("[sftp] subdir failed {remote_child}: {e}");
                *failed += 1;
            }
        } else {
            match download(sftp, &remote_child, &local_child).await {
                Ok(()) => *done += 1,
                Err(e) => {
                    eprintln!("[sftp] file failed {remote_child}: {e}");
                    *failed += 1;
                }
            }
            emit(
                "ssh-sftp-progress",
                to_json(DownloadProgress {
                    op_id,
                    done: *done,
                    failed: *failed,
                    current: entry.name.clone(),
                    finished: false,
                }),
            );
        }
    }
    Ok(())
}

/// Upload a local file to a remote path.
pub async fn upload(sftp: &SftpSession, local: &str, remote: &str) -> Result<(), String> {
    let bytes = std::fs::read(local).map_err(|e| format!("upload read failed: {e}"))?;
    write_bytes(sftp, remote, &bytes).await
}

pub async fn mkdir(sftp: &SftpSession, path: &str) -> Result<(), String> {
    sftp.create_dir(path)
        .await
        .map_err(|e| format!("mkdir failed: {e}"))
}

pub async fn rename(sftp: &SftpSession, from: &str, to: &str) -> Result<(), String> {
    sftp.rename(from, to)
        .await
        .map_err(|e| format!("rename failed: {e}"))
}

/// Delete a file or (empty) directory.
pub async fn delete(sftp: &SftpSession, path: &str, is_dir: bool) -> Result<(), String> {
    if is_dir {
        sftp.remove_dir(path)
            .await
            .map_err(|e| format!("remove_dir failed: {e}"))
    } else {
        sftp.remove_file(path)
            .await
            .map_err(|e| format!("remove_file failed: {e}"))
    }
}
