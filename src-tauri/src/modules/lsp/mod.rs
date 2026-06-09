//! Language Server Protocol transport.
//!
//! This layer is deliberately dumb: it spawns a server process, frames bytes
//! (see `framing`), and shuttles whole JSON messages between the frontend and
//! the server's stdio. All JSON-RPC semantics (request correlation, the
//! initialize handshake, document sync) live in the TypeScript client.

mod install;
mod process;

// Glob re-export so `tauri::generate_handler!` can reach the hidden `__cmd__*`
// items the `#[tauri::command]` macro generates alongside each function.
pub use install::*;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, RwLock};

use tauri::ipc::Channel;

use crate::modules::workspace::{authorize_user_spawn_cwd, WorkspaceEnv, WorkspaceRegistry};
use process::LspServer;

pub struct LspState {
    servers: RwLock<HashMap<u32, Arc<LspServer>>>,
    next_id: AtomicU32,
}

impl Default for LspState {
    fn default() -> Self {
        Self {
            servers: RwLock::new(HashMap::new()),
            next_id: AtomicU32::new(1),
        }
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn lsp_start(
    state: tauri::State<'_, LspState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
    language_id: String,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    on_message: Channel<String>,
) -> Result<u32, String> {
    if command.trim().is_empty() {
        return Err("empty language server command".into());
    }
    // Language servers run locally against on-disk paths; WSL roots aren't
    // supported yet (the server would resolve paths inside the distro).
    let root = authorize_user_spawn_cwd(&registry, cwd.as_deref(), &WorkspaceEnv::Local)?;

    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let server = tauri::async_runtime::spawn_blocking(move || {
        process::spawn(&command, &args, root, on_message)
    })
    .await
    .map_err(|e| {
        log::error!("lsp_start join failed: {e}");
        e.to_string()
    })??;

    state.servers.write().unwrap().insert(id, Arc::new(server));
    log::info!("lsp_start id={id} language={language_id}");
    Ok(id)
}

#[tauri::command]
pub fn lsp_send(state: tauri::State<LspState>, id: u32, message: String) -> Result<(), String> {
    let server = state
        .servers
        .read()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            log::warn!("lsp_send: unknown id={id}");
            "no language server".to_string()
        })?;
    server.send(&message)
}

#[tauri::command]
pub fn lsp_stop(state: tauri::State<LspState>, id: u32) -> Result<(), String> {
    if let Some(server) = state.servers.write().unwrap().remove(&id) {
        server.kill();
        log::info!("lsp_stop id={id} pid={}", server.pid);
    } else {
        log::debug!("lsp_stop: unknown id={id}");
    }
    Ok(())
}

// A fresh webview load orphans the previous frontend's servers; reap them on
// boot the same way `pty_close_all` does.
#[tauri::command]
pub fn lsp_stop_all(state: tauri::State<LspState>) -> Result<usize, String> {
    let drained: Vec<Arc<LspServer>> = {
        let mut servers = state.servers.write().unwrap();
        servers.drain().map(|(_, s)| s).collect()
    };
    let count = drained.len();
    for server in drained {
        server.kill();
    }
    if count > 0 {
        log::info!("lsp_stop_all: reaped {count} orphaned server(s)");
    }
    Ok(count)
}
