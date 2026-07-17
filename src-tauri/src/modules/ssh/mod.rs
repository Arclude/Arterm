//! SSH integration: saved-connection sessions whose interactive shells reuse
//! the local terminal's byte pipeline. A "connection" is one authenticated
//! transport (russh `Handle`) that can host many shell channels (one per
//! terminal tab) plus an SFTP channel — all without re-authenticating.

mod session;
mod sftp;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use russh::client::Handle;
use russh_sftp::client::SftpSession;
use tauri::ipc::{Channel, Response};
use tauri::Emitter;
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::modules::pty::session::{DataSink, EventSink, ExitSink};
use crate::modules::workspace::{authorize_fs_path, WorkspaceEnv, WorkspaceRegistry};
use session::Client;
pub use session::{ConnectConfig, ShellCmd};
use sftp::SftpEntry;

pub struct SshState {
    /// Authenticated transports keyed by connection id.
    conns: Mutex<HashMap<u32, Arc<Handle<Client>>>>,
    /// Live shell tasks keyed by shell-session id. The value carries the owning
    /// connection id so `ssh_disconnect` can reap every shell of a connection.
    shells: Mutex<HashMap<u32, (u32, mpsc::UnboundedSender<ShellCmd>)>>,
    /// Lazily-opened SFTP subsystem per connection id.
    sftp: Mutex<HashMap<u32, Arc<SftpSession>>>,
    /// Host-key prompt one-shots awaiting a user decision, keyed by conn id.
    pending_hostkey: Mutex<HashMap<u32, oneshot::Sender<bool>>>,
    /// Monotonic; shared by connection and shell ids. Starts at 1 so a handed-out
    /// id is never 0 (the frontend treats 0 as "unset").
    next_id: AtomicU32,
}

impl Default for SshState {
    fn default() -> Self {
        Self {
            conns: Mutex::new(HashMap::new()),
            shells: Mutex::new(HashMap::new()),
            sftp: Mutex::new(HashMap::new()),
            pending_hostkey: Mutex::new(HashMap::new()),
            next_id: AtomicU32::new(1),
        }
    }
}

pub(crate) async fn ssh_connect_impl(
    state: &SshState,
    emit: EventSink,
    config: ConnectConfig,
) -> Result<u32, String> {
    let conn_id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel::<bool>();
    state.pending_hostkey.lock().await.insert(conn_id, tx);

    // The await may block on the host-key prompt; the frontend resolves it
    // concurrently via `ssh_known_host_decision`.
    let result = session::connect(emit, conn_id, config, rx).await;
    state.pending_hostkey.lock().await.remove(&conn_id);

    let handle = result?;
    state.conns.lock().await.insert(conn_id, Arc::new(handle));
    log::info!("ssh connected id={conn_id}");
    Ok(conn_id)
}

pub(crate) async fn ssh_open_shell_impl(
    state: &SshState,
    conn_id: u32,
    cols: u16,
    rows: u16,
    on_data: DataSink,
    on_exit: ExitSink,
) -> Result<u32, String> {
    let handle = state
        .conns
        .lock()
        .await
        .get(&conn_id)
        .cloned()
        .ok_or_else(|| format!("ssh_open_shell: no connection {conn_id}"))?;
    let tx = session::open_shell(&handle, cols, rows, on_data, on_exit).await?;
    let sid = state.next_id.fetch_add(1, Ordering::Relaxed);
    state.shells.lock().await.insert(sid, (conn_id, tx));
    log::info!("ssh shell opened id={sid} conn={conn_id}");
    Ok(sid)
}

pub(crate) async fn ssh_write_impl(state: &SshState, id: u32, data: String) -> Result<(), String> {
    let tx = state
        .shells
        .lock()
        .await
        .get(&id)
        .map(|(_, tx)| tx.clone())
        .ok_or_else(|| format!("ssh_write: no shell {id}"))?;
    tx.send(ShellCmd::Data(data.into_bytes()))
        .map_err(|_| "ssh shell closed".to_string())
}

pub(crate) async fn ssh_resize_impl(
    state: &SshState,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let tx = state
        .shells
        .lock()
        .await
        .get(&id)
        .map(|(_, tx)| tx.clone())
        .ok_or_else(|| format!("ssh_resize: no shell {id}"))?;
    tx.send(ShellCmd::Resize(cols, rows))
        .map_err(|_| "ssh shell closed".to_string())
}

pub(crate) async fn ssh_close_impl(state: &SshState, id: u32) -> Result<(), String> {
    if let Some((_, tx)) = state.shells.lock().await.remove(&id) {
        let _ = tx.send(ShellCmd::Close);
    }
    Ok(())
}

pub(crate) async fn ssh_disconnect_impl(state: &SshState, conn_id: u32) -> Result<(), String> {
    state.sftp.lock().await.remove(&conn_id);
    // Reap every shell task belonging to this connection so its sender entries
    // (and the spawned shell tasks they drive) don't linger in the map across
    // reconnect cycles.
    {
        let mut shells = state.shells.lock().await;
        let sids: Vec<u32> = shells
            .iter()
            .filter(|(_, (cid, _))| *cid == conn_id)
            .map(|(sid, _)| *sid)
            .collect();
        for sid in sids {
            if let Some((_, tx)) = shells.remove(&sid) {
                let _ = tx.send(ShellCmd::Close);
            }
        }
    }
    if let Some(handle) = state.conns.lock().await.remove(&conn_id) {
        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "", "")
            .await;
    }
    log::info!("ssh disconnected id={conn_id}");
    Ok(())
}

pub(crate) async fn ssh_known_host_decision_impl(
    state: &SshState,
    conn_id: u32,
    accept: bool,
) -> Result<(), String> {
    if let Some(tx) = state.pending_hostkey.lock().await.remove(&conn_id) {
        let _ = tx.send(accept);
    }
    Ok(())
}

/// Fetch (or lazily open) the SFTP subsystem for a connection.
async fn get_sftp(state: &SshState, conn_id: u32) -> Result<Arc<SftpSession>, String> {
    if let Some(s) = state.sftp.lock().await.get(&conn_id).cloned() {
        return Ok(s);
    }
    let handle = state
        .conns
        .lock()
        .await
        .get(&conn_id)
        .cloned()
        .ok_or_else(|| format!("sftp: no connection {conn_id}"))?;
    let session = Arc::new(sftp::open_sftp(&handle).await?);
    state.sftp.lock().await.insert(conn_id, session.clone());
    Ok(session)
}

pub(crate) async fn ssh_sftp_list_impl(
    state: &SshState,
    conn_id: u32,
    path: String,
) -> Result<Vec<SftpEntry>, String> {
    let sftp = get_sftp(state, conn_id).await?;
    sftp::list(&sftp, &path).await
}

pub(crate) async fn ssh_sftp_read_impl(
    state: &SshState,
    conn_id: u32,
    path: String,
) -> Result<String, String> {
    let sftp = get_sftp(state, conn_id).await?;
    sftp::read_text(&sftp, &path).await
}

pub(crate) async fn ssh_sftp_write_impl(
    state: &SshState,
    conn_id: u32,
    path: String,
    contents: String,
) -> Result<(), String> {
    let sftp = get_sftp(state, conn_id).await?;
    sftp::write_text(&sftp, &path, &contents).await
}

pub(crate) async fn ssh_sftp_download_impl(
    state: &SshState,
    registry: &WorkspaceRegistry,
    conn_id: u32,
    remote: String,
    local: String,
) -> Result<(), String> {
    // The local destination is an arbitrary host path from the frontend; require
    // it to live under an authorized workspace root so a compromised webview
    // can't drop a remote file into e.g. an autostart dir.
    let local = authorize_fs_path(registry, &local, &WorkspaceEnv::Local)?;
    let sftp = get_sftp(state, conn_id).await?;
    sftp::download(&sftp, &remote, &local.to_string_lossy()).await
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn ssh_sftp_download_dir_impl(
    state: &SshState,
    registry: &WorkspaceRegistry,
    emit: EventSink,
    conn_id: u32,
    op_id: u32,
    remote: String,
    local: String,
) -> Result<sftp::DownloadSummary, String> {
    // Same gate as the single-file download: the destination must resolve under
    // an authorized root (the home dir, which covers ~/Downloads).
    let local = authorize_fs_path(registry, &local, &WorkspaceEnv::Local)?;
    let sftp = get_sftp(state, conn_id).await?;
    sftp::download_dir(&emit, op_id, &sftp, &remote, &local.to_string_lossy()).await
}

pub(crate) async fn ssh_sftp_upload_impl(
    state: &SshState,
    registry: &WorkspaceRegistry,
    conn_id: u32,
    local: String,
    remote: String,
) -> Result<(), String> {
    // Same gate on the local source path — prevents a compromised webview from
    // exfiltrating arbitrary local files up to a remote server.
    let local = authorize_fs_path(registry, &local, &WorkspaceEnv::Local)?;
    let sftp = get_sftp(state, conn_id).await?;
    sftp::upload(&sftp, &local.to_string_lossy(), &remote).await
}

pub(crate) async fn ssh_sftp_mkdir_impl(
    state: &SshState,
    conn_id: u32,
    path: String,
) -> Result<(), String> {
    let sftp = get_sftp(state, conn_id).await?;
    sftp::mkdir(&sftp, &path).await
}

pub(crate) async fn ssh_sftp_rename_impl(
    state: &SshState,
    conn_id: u32,
    from: String,
    to: String,
) -> Result<(), String> {
    let sftp = get_sftp(state, conn_id).await?;
    sftp::rename(&sftp, &from, &to).await
}

pub(crate) async fn ssh_sftp_delete_impl(
    state: &SshState,
    conn_id: u32,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let sftp = get_sftp(state, conn_id).await?;
    sftp::delete(&sftp, &path, is_dir).await
}

/// Wrap a Tauri `AppHandle` as the shell-agnostic event sink the impls expect.
fn app_emit_sink(app: tauri::AppHandle) -> EventSink {
    Arc::new(move |event: &str, payload: serde_json::Value| {
        let _ = app.emit(event, payload);
    })
}

#[tauri::command]
pub async fn ssh_connect(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshState>,
    config: ConnectConfig,
) -> Result<u32, String> {
    ssh_connect_impl(&state, app_emit_sink(app), config).await
}

#[tauri::command]
pub async fn ssh_open_shell(
    state: tauri::State<'_, SshState>,
    conn_id: u32,
    cols: u16,
    rows: u16,
    on_data: Channel<Response>,
    on_exit: Channel<i32>,
) -> Result<u32, String> {
    let data_sink: DataSink = Arc::new(move |bytes| on_data.send(Response::new(bytes)).is_ok());
    let exit_sink: ExitSink = Box::new(move |code| {
        let _ = on_exit.send(code);
    });
    ssh_open_shell_impl(&state, conn_id, cols, rows, data_sink, exit_sink).await
}

#[tauri::command]
pub async fn ssh_write(
    state: tauri::State<'_, SshState>,
    id: u32,
    data: String,
) -> Result<(), String> {
    ssh_write_impl(&state, id, data).await
}

#[tauri::command]
pub async fn ssh_resize(
    state: tauri::State<'_, SshState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    ssh_resize_impl(&state, id, cols, rows).await
}

#[tauri::command]
pub async fn ssh_close(state: tauri::State<'_, SshState>, id: u32) -> Result<(), String> {
    ssh_close_impl(&state, id).await
}

#[tauri::command]
pub async fn ssh_disconnect(state: tauri::State<'_, SshState>, conn_id: u32) -> Result<(), String> {
    ssh_disconnect_impl(&state, conn_id).await
}

#[tauri::command]
pub async fn ssh_known_host_decision(
    state: tauri::State<'_, SshState>,
    conn_id: u32,
    accept: bool,
) -> Result<(), String> {
    ssh_known_host_decision_impl(&state, conn_id, accept).await
}

#[tauri::command]
pub async fn ssh_sftp_list(
    state: tauri::State<'_, SshState>,
    conn_id: u32,
    path: String,
) -> Result<Vec<SftpEntry>, String> {
    ssh_sftp_list_impl(&state, conn_id, path).await
}

#[tauri::command]
pub async fn ssh_sftp_read(
    state: tauri::State<'_, SshState>,
    conn_id: u32,
    path: String,
) -> Result<String, String> {
    ssh_sftp_read_impl(&state, conn_id, path).await
}

#[tauri::command]
pub async fn ssh_sftp_write(
    state: tauri::State<'_, SshState>,
    conn_id: u32,
    path: String,
    contents: String,
) -> Result<(), String> {
    ssh_sftp_write_impl(&state, conn_id, path, contents).await
}

#[tauri::command]
pub async fn ssh_sftp_download(
    state: tauri::State<'_, SshState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
    conn_id: u32,
    remote: String,
    local: String,
) -> Result<(), String> {
    ssh_sftp_download_impl(&state, &registry, conn_id, remote, local).await
}

#[tauri::command]
pub async fn ssh_sftp_download_dir(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
    conn_id: u32,
    op_id: u32,
    remote: String,
    local: String,
) -> Result<sftp::DownloadSummary, String> {
    ssh_sftp_download_dir_impl(
        &state,
        &registry,
        app_emit_sink(app),
        conn_id,
        op_id,
        remote,
        local,
    )
    .await
}

#[tauri::command]
pub async fn ssh_sftp_upload(
    state: tauri::State<'_, SshState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
    conn_id: u32,
    local: String,
    remote: String,
) -> Result<(), String> {
    ssh_sftp_upload_impl(&state, &registry, conn_id, local, remote).await
}

#[tauri::command]
pub async fn ssh_sftp_mkdir(
    state: tauri::State<'_, SshState>,
    conn_id: u32,
    path: String,
) -> Result<(), String> {
    ssh_sftp_mkdir_impl(&state, conn_id, path).await
}

#[tauri::command]
pub async fn ssh_sftp_rename(
    state: tauri::State<'_, SshState>,
    conn_id: u32,
    from: String,
    to: String,
) -> Result<(), String> {
    ssh_sftp_rename_impl(&state, conn_id, from, to).await
}

#[tauri::command]
pub async fn ssh_sftp_delete(
    state: tauri::State<'_, SshState>,
    conn_id: u32,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    ssh_sftp_delete_impl(&state, conn_id, path, is_dir).await
}
