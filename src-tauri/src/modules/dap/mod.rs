//! Debug Adapter Protocol transport.
//!
//! Like `lsp`, this layer is deliberately dumb: it spawns a debug adapter
//! process, frames bytes (shared `proto::framing`), and shuttles whole JSON
//! messages between the frontend and the adapter's stdio. All DAP semantics
//! (seq correlation, the initialize/launch/configurationDone handshake, event
//! dispatch) live in the TypeScript client.

mod process;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, RwLock};

use tauri::ipc::Channel;

use crate::modules::workspace::{authorize_user_spawn_cwd, WorkspaceEnv, WorkspaceRegistry};
use process::DebugAdapter;

pub struct DapState {
    adapters: RwLock<HashMap<u32, Arc<DebugAdapter>>>,
    next_id: AtomicU32,
}

impl Default for DapState {
    fn default() -> Self {
        Self {
            adapters: RwLock::new(HashMap::new()),
            next_id: AtomicU32::new(1),
        }
    }
}

#[tauri::command]
pub async fn dap_start(
    state: tauri::State<'_, DapState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    on_message: Channel<String>,
) -> Result<u32, String> {
    if command.trim().is_empty() {
        return Err("empty debug adapter command".into());
    }
    // Debug adapters launch the debuggee against on-disk paths; like LSP, WSL
    // roots aren't supported yet.
    let root = authorize_user_spawn_cwd(&registry, cwd.as_deref(), &WorkspaceEnv::Local)?;

    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let adapter = tauri::async_runtime::spawn_blocking(move || {
        process::spawn(&command, &args, root, on_message)
    })
    .await
    .map_err(|e| {
        log::error!("dap_start join failed: {e}");
        e.to_string()
    })??;

    state.adapters.write().unwrap().insert(id, Arc::new(adapter));
    log::info!("dap_start id={id}");
    Ok(id)
}

#[tauri::command]
pub fn dap_send(state: tauri::State<DapState>, id: u32, message: String) -> Result<(), String> {
    let adapter = state
        .adapters
        .read()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            log::warn!("dap_send: unknown id={id}");
            "no debug adapter".to_string()
        })?;
    adapter.send(&message)
}

#[tauri::command]
pub fn dap_stop(state: tauri::State<DapState>, id: u32) -> Result<(), String> {
    if let Some(adapter) = state.adapters.write().unwrap().remove(&id) {
        adapter.kill();
        log::info!("dap_stop id={id} pid={}", adapter.pid);
    } else {
        log::debug!("dap_stop: unknown id={id}");
    }
    Ok(())
}

// A fresh webview load orphans the previous frontend's adapters; reap them on
// boot the same way `lsp_stop_all` / `pty_close_all` do.
#[tauri::command]
pub fn dap_stop_all(state: tauri::State<DapState>) -> Result<usize, String> {
    let drained: Vec<Arc<DebugAdapter>> = {
        let mut adapters = state.adapters.write().unwrap();
        adapters.drain().map(|(_, a)| a).collect()
    };
    let count = drained.len();
    for adapter in drained {
        adapter.kill();
    }
    if count > 0 {
        log::info!("dap_stop_all: reaped {count} orphaned adapter(s)");
    }
    Ok(count)
}
