//! SFTP operations layered over an existing SSH connection. The SFTP subsystem
//! runs on its own channel, so file transfers never contend with an interactive
//! shell on the same connection.

use russh::client::Handle;
use russh_sftp::client::SftpSession;
use serde::Serialize;

use super::session::Client;

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

pub async fn write_text(sftp: &SftpSession, path: &str, contents: &str) -> Result<(), String> {
    sftp.write(path, contents.as_bytes())
        .await
        .map_err(|e| format!("write failed: {e}"))
}

/// Stream a remote file down to a local path.
pub async fn download(sftp: &SftpSession, remote: &str, local: &str) -> Result<(), String> {
    let bytes = sftp
        .read(remote)
        .await
        .map_err(|e| format!("download read failed: {e}"))?;
    std::fs::write(local, bytes).map_err(|e| format!("download write failed: {e}"))
}

/// Upload a local file to a remote path.
pub async fn upload(sftp: &SftpSession, local: &str, remote: &str) -> Result<(), String> {
    let bytes = std::fs::read(local).map_err(|e| format!("upload read failed: {e}"))?;
    sftp.write(remote, &bytes)
        .await
        .map_err(|e| format!("upload write failed: {e}"))
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
