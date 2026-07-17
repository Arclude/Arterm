mod agent_detect;
mod command_detect;
mod da_filter;
#[cfg(windows)]
mod job;
pub(crate) mod session;
pub(crate) mod shell_init;

// Reused by the lsp module to reap server subtrees on Windows.
#[cfg(windows)]
pub(crate) use job::PtyJob;

use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, RwLock};
use std::thread;

use portable_pty::PtySize;
use tauri::ipc::{Channel, Response};
use tauri::Emitter;

use crate::modules::workspace::{authorize_user_spawn_cwd, WorkspaceEnv, WorkspaceRegistry};
use session::Session;

pub struct PtyState {
    sessions: RwLock<HashMap<u32, Arc<Session>>>,
    // Starts at 1 so freshly-handed-out ids are never 0, which the frontend
    // sometimes treats as "unset". Increments monotonically; never reused.
    next_id: AtomicU32,
}

impl Default for PtyState {
    fn default() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            next_id: AtomicU32::new(1),
        }
    }
}

// Shell-agnostic command bodies. The #[tauri::command] wrappers below and the
// Electron bridge (crate::bridge) both dispatch here, so behavior can't drift
// between the two shells.
impl PtyState {
    pub(crate) fn alloc_id(&self) -> u32 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    pub(crate) fn insert(&self, id: u32, session: Arc<Session>) {
        self.sessions.write().unwrap().insert(id, session);
    }

    fn get(&self, id: u32, ctx: &str) -> Result<Arc<Session>, String> {
        self.sessions
            .read()
            .unwrap()
            .get(&id)
            .cloned()
            .ok_or_else(|| {
                log::warn!("{ctx}: unknown id={id}");
                "no session".to_string()
            })
    }

    pub(crate) fn write(&self, id: u32, data: &str) -> Result<(), String> {
        let session = self.get(id, "pty_write")?;
        // Bind to a local so the MutexGuard temporary drops before `session` —
        // see rustc note on tail-expression temporary drop order.
        let result = session
            .writer
            .lock()
            .unwrap()
            .write_all(data.as_bytes())
            .map_err(|e| {
                // EPIPE is expected if the child already exited.
                log::debug!("pty_write id={id} failed: {e}");
                e.to_string()
            });
        result
    }

    pub(crate) fn set_paused(&self, id: u32, paused: bool) -> Result<(), String> {
        let ctx = if paused { "pty_pause" } else { "pty_resume" };
        let session = self.get(id, ctx)?;
        session.set_flow_paused(paused);
        log::debug!("{ctx} id={id}");
        Ok(())
    }

    pub(crate) fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<(), String> {
        let session = self.get(id, "pty_resize")?;
        let result = session
            .master
            .lock()
            .unwrap()
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| {
                log::warn!("pty_resize id={id} failed: {e}");
                e.to_string()
            });
        result
    }

    pub(crate) fn close(&self, id: u32) {
        let session = self.sessions.write().unwrap().remove(&id);
        if let Some(s) = session {
            if let Err(e) = s.killer.lock().unwrap().kill() {
                // Non-fatal: the child may already have exited on its own (e.g. the
                // user ran `exit`). Log so this isn't invisible during debugging.
                log::debug!("pty_close: kill id={id} returned {e}");
            }
            log::info!("pty closed id={id}");
            // Detached: on Windows `ClosePseudoConsole` can block until conhost
            // drains, which would freeze this Tauri worker thread and stall IPC.
            thread::Builder::new()
                .name(format!("arterm-pty-drop-{id}"))
                .spawn(move || {
                    let t0 = std::time::Instant::now();
                    session::drop_session(s);
                    log::info!(
                        "pty session id={id} dropped in {}ms",
                        t0.elapsed().as_millis()
                    );
                })
                .expect("spawn pty drop thread");
        } else {
            log::debug!("pty_close: unknown id={id}");
        }
    }

    pub(crate) fn shell_label(&self, id: u32) -> Result<String, String> {
        let sessions = self.sessions.read().unwrap();
        let session = sessions
            .get(&id)
            .ok_or_else(|| format!("unknown pty id={id}"))?;
        Ok(session.shell_label.to_string())
    }

    pub(crate) fn has_foreground_process(&self, id: u32) -> Result<bool, String> {
        let sessions = self.sessions.read().unwrap();
        let session = sessions.get(&id).ok_or_else(|| {
            log::warn!("pty_has_foreground_process: unknown session id={id}");
            "no session".to_string()
        })?;
        let shell_pid = session.shell_pid;
        if shell_pid == 0 {
            return Ok(false);
        }
        Ok(shell_has_children(shell_pid))
    }

    pub(crate) fn close_all(&self) -> usize {
        let drained: Vec<(u32, Arc<Session>)> = {
            let mut sessions = self.sessions.write().unwrap();
            sessions.drain().collect()
        };
        let count = drained.len();
        for (id, s) in drained {
            if let Err(e) = s.killer.lock().unwrap().kill() {
                log::debug!("pty_close_all: kill id={id} returned {e}");
            }
            thread::Builder::new()
                .name(format!("arterm-pty-drop-{id}"))
                .spawn(move || session::drop_session(s))
                .expect("spawn pty drop thread");
        }
        if count > 0 {
            log::info!("pty_close_all: reaped {count} orphaned session(s)");
        }
        count
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn pty_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, PtyState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    workspace: Option<WorkspaceEnv>,
    on_data: Channel<Response>,
    on_exit: Channel<i32>,
) -> Result<u32, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    authorize_user_spawn_cwd(&registry, cwd.as_deref(), &workspace).map_err(|e| {
        log::warn!("pty_open: cwd rejected: {e}");
        e
    })?;
    let id = state.alloc_id();
    let emit: session::EventSink = Arc::new(move |event, payload| {
        let _ = app.emit(event, payload);
    });
    let on_data: session::DataSink =
        Arc::new(move |bytes| on_data.send(Response::new(bytes)).is_ok());
    let on_exit: session::ExitSink = Box::new(move |code| {
        let _ = on_exit.send(code);
    });
    let session = tauri::async_runtime::spawn_blocking(move || {
        session::spawn(id, emit, cols, rows, cwd, workspace, on_data, on_exit).map(|(s, _)| s)
    })
    .await
    .map_err(|e| {
        log::error!("pty_open join failed: {e}");
        e.to_string()
    })?
    .map_err(|e| {
        log::error!("pty_open failed: {e}");
        e
    })?;
    state.insert(id, session);
    log::info!("pty opened id={id} cols={cols} rows={rows}");
    Ok(id)
}

#[tauri::command]
pub fn pty_write(state: tauri::State<PtyState>, id: u32, data: String) -> Result<(), String> {
    state.write(id, &data)
}

// Frontend flow control: pause/resume the backend's flusher. When the renderer
// (xterm) falls behind on a heavy burst it pauses, which lets the backend buffer
// fill to MAX_PENDING and then blocks the reader — backpressuring the child
// through the kernel PTY buffer instead of discarding output. See session.rs.
#[tauri::command]
pub fn pty_pause(state: tauri::State<PtyState>, id: u32) -> Result<(), String> {
    state.set_paused(id, true)
}

#[tauri::command]
pub fn pty_resume(state: tauri::State<PtyState>, id: u32) -> Result<(), String> {
    state.set_paused(id, false)
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<PtyState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.resize(id, cols, rows)
}

#[tauri::command]
pub fn pty_close(state: tauri::State<PtyState>, id: u32) -> Result<(), String> {
    state.close(id);
    Ok(())
}

#[tauri::command]
pub fn pty_shell_label(state: tauri::State<PtyState>, id: u32) -> Result<String, String> {
    state.shell_label(id)
}

#[tauri::command]
pub fn pty_has_foreground_process(state: tauri::State<PtyState>, id: u32) -> Result<bool, String> {
    state.has_foreground_process(id)
}

// pgrep -P exits 0 when shell_pid has at least one child, 1 when none.
#[cfg(unix)]
fn shell_has_children(shell_pid: u32) -> bool {
    std::process::Command::new("pgrep")
        .args(["-P", &shell_pid.to_string()])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(windows)]
fn shell_has_children(shell_pid: u32) -> bool {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32First, Process32Next, PROCESSENTRY32, TH32CS_SNAPPROCESS,
    };
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return false;
        }
        let mut entry: PROCESSENTRY32 = zeroed();
        entry.dwSize = size_of::<PROCESSENTRY32>() as u32;
        let mut found = false;
        if Process32First(snapshot, &mut entry) != 0 {
            loop {
                if entry.th32ParentProcessID == shell_pid {
                    found = true;
                    break;
                }
                if Process32Next(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
        found
    }
}

// A fresh webview load orphans the previous frontend's sessions in this still
// running process; reap them on boot before any new tab spawns.
#[tauri::command]
pub fn pty_close_all(state: tauri::State<PtyState>) -> Result<usize, String> {
    Ok(state.close_all())
}
