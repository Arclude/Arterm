//! WebSocket bridge for the Electron shell (Linux).
//!
//! The Tauri shell talks to this backend through webview IPC; on Linux the
//! frontend runs inside Electron instead, so the same module logic is exposed
//! over a localhost WebSocket. Protocol (v1), mirrored by
//! `src/platform/electron/transport.ts`:
//!
//! - client → server text: `{"t":"invoke","id":n,"cmd":"...","args":{...}}`
//!   where Tauri `Channel` args arrive as `{"__arterm_chan__":<u32>}`
//! - server → client text: `{"t":"result","id":n,"ok":bool,...}`,
//!   `{"t":"chan","chan":n,"value":json}`, `{"t":"event","event":"...","payload":json}`
//! - server → client binary: 4-byte LE channel id followed by raw bytes
//!   (the PTY hot path — no base64/JSON round-trip, same as Tauri `Channel<Response>`)

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::handshake::server::{
    ErrorResponse, Request, Response as HsResponse,
};
use tokio_tungstenite::tungstenite::Message;

use crate::modules::dap::DapState;
use crate::modules::git::operations as git_ops;
use crate::modules::git::types::DiscardEntry;
use crate::modules::lsp::LspState;
use crate::modules::proto::MessageSink;
use crate::modules::pty::session::{self, EventSink};
use crate::modules::pty::PtyState;
use crate::modules::shell::ShellState;
use crate::modules::secrets::SecretsState;
use crate::modules::ssh::SshState;
use crate::modules::fs::watch::FsWatchState;
use crate::modules::workspace::{
    authorize_user_spawn_cwd, authorize_workspace_path, bootstrap_registry, WorkspaceEnv,
    WorkspaceRegistry,
};
use crate::modules::{dap, extensions, fs, lsp, net, secrets, shell, ssh};

/// App identifier, matching `tauri.conf.json`. Used to reproduce Tauri's
/// `app_local_data_dir` so the Electron bridge reads/writes the same secrets
/// and extensions store as the Tauri shell.
const APP_IDENTIFIER: &str = "app.arclude.arterm";

struct BridgeState {
    pty: PtyState,
    shell: ShellState,
    secrets: SecretsState,
    fs_watch: FsWatchState,
    lsp: LspState,
    dap: DapState,
    ssh: SshState,
    registry: WorkspaceRegistry,
    /// Drained on first read, mirroring the Tauri shell's `get_launch_dir`.
    launch_dir: Mutex<Option<String>>,
    /// Live connections, for fanning `{"t":"event",...}` out to every client.
    /// Registered on connect, removed on disconnect.
    conns: Mutex<Vec<(u64, OutTx)>>,
    next_conn: AtomicU64,
}

impl BridgeState {
    fn register_conn(&self, tx: OutTx) -> u64 {
        let id = self.next_conn.fetch_add(1, Ordering::Relaxed);
        self.conns.lock().unwrap().push((id, tx));
        id
    }

    fn unregister_conn(&self, id: u64) {
        self.conns.lock().unwrap().retain(|(cid, _)| *cid != id);
    }

    /// A shell-agnostic event sink that broadcasts to every live connection,
    /// mirroring the Tauri shell's process-global `AppHandle::emit`.
    fn event_sink(self: &Arc<Self>) -> EventSink {
        let state = Arc::clone(self);
        Arc::new(move |event: &str, payload: Value| {
            let text = json!({"t":"event","event":event,"payload":payload}).to_string();
            for (_, tx) in state.conns.lock().unwrap().iter() {
                let _ = tx.send(Out::Text(text.clone()));
            }
        })
    }
}

/// Reproduces Tauri's Linux `app_local_data_dir` without a Tauri `AppHandle`.
/// `dirs::data_local_dir()` resolves the same `$XDG_DATA_HOME`/`~/.local/share`
/// base Tauri uses, and we append the identifier exactly as Tauri does.
fn app_local_data_dir() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .map(|d| d.join(APP_IDENTIFIER))
        .ok_or_else(|| "bridge: no local data dir".to_string())
}

enum Out {
    Text(String),
    Bin(Vec<u8>),
}

type OutTx = mpsc::UnboundedSender<Out>;

pub async fn run(launch_dir: Option<String>) {
    crate::modules::workspace::init_launch_cwd(launch_dir.as_deref());
    let token = gen_token();
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bridge: bind failed");
    let port = listener.local_addr().expect("bridge: local_addr").port();
    // The Electron main process parses this exact line to learn where to connect.
    println!("ARTERM_BRIDGE_READY ws://127.0.0.1:{port} {token}");
    {
        use std::io::Write as _;
        let _ = std::io::stdout().flush();
    }

    let state = Arc::new(BridgeState {
        pty: PtyState::default(),
        shell: ShellState::default(),
        secrets: SecretsState::default(),
        fs_watch: FsWatchState::default(),
        lsp: LspState::default(),
        dap: DapState::default(),
        ssh: SshState::default(),
        registry: {
            let registry = WorkspaceRegistry::default();
            bootstrap_registry(&registry);
            if let Some(ref dir) = launch_dir {
                let _ = registry.authorize(dir);
            }
            registry
        },
        launch_dir: Mutex::new(launch_dir),
        conns: Mutex::new(Vec::new()),
        next_conn: AtomicU64::new(1),
    });

    loop {
        let Ok((stream, addr)) = listener.accept().await else {
            continue;
        };
        let state = state.clone();
        let token = token.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_conn(stream, state, token).await {
                eprintln!("bridge: connection {addr} ended: {e}");
            }
        });
    }
}

async fn handle_conn(
    stream: TcpStream,
    state: Arc<BridgeState>,
    token: String,
) -> Result<(), String> {
    let ws = tokio_tungstenite::accept_hdr_async(stream, |req: &Request, res: HsResponse| {
        let expected = format!("token={token}");
        let ok = req
            .uri()
            .query()
            .map(|q| q.split('&').any(|kv| kv == expected))
            .unwrap_or(false);
        if ok {
            Ok(res)
        } else {
            let mut deny = ErrorResponse::new(Some("unauthorized".into()));
            *deny.status_mut() = tokio_tungstenite::tungstenite::http::StatusCode::UNAUTHORIZED;
            Err(deny)
        }
    })
    .await
    .map_err(|e| e.to_string())?;

    let (mut sink, mut incoming) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Out>();

    // Register this connection so broadcast events (fs watch, file-written)
    // reach it; removed on disconnect below.
    let conn_id = state.register_conn(tx.clone());

    // Single owner of the WS sink: PTY reader/flusher threads and invoke
    // replies all funnel through the mpsc from arbitrary threads.
    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let m = match msg {
                Out::Text(s) => Message::Text(s.into()),
                Out::Bin(b) => Message::Binary(b.into()),
            };
            if sink.send(m).await.is_err() {
                break;
            }
        }
    });

    while let Some(msg) = incoming.next().await {
        let msg = msg.map_err(|e| e.to_string())?;
        match msg {
            Message::Text(text) => {
                let v: Value = match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!("bridge: unparseable message: {e}");
                        continue;
                    }
                };
                if v["t"].as_str() == Some("invoke") {
                    let id = v["id"].as_u64().unwrap_or(0);
                    let cmd = v["cmd"].as_str().unwrap_or("").to_string();
                    let args = v["args"].clone();
                    // Fast, latency-sensitive commands run inline so per-
                    // connection FIFO order holds — concurrent pty_write tasks
                    // could otherwise reorder keystrokes. Slow commands (child
                    // spawns, disk/git/network work) go to a task so a long git
                    // diff can't stall typing.
                    if is_fast_command(&cmd) {
                        let reply = match dispatch(&state, &tx, &cmd, args).await {
                            Ok(value) => json!({"t":"result","id":id,"ok":true,"value":value}),
                            Err(error) => json!({"t":"result","id":id,"ok":false,"error":error}),
                        };
                        let _ = tx.send(Out::Text(reply.to_string()));
                    } else {
                        let state = state.clone();
                        let tx = tx.clone();
                        tokio::spawn(async move {
                            let reply = match dispatch(&state, &tx, &cmd, args).await {
                                Ok(value) => json!({"t":"result","id":id,"ok":true,"value":value}),
                                Err(error) => json!({"t":"result","id":id,"ok":false,"error":error}),
                            };
                            let _ = tx.send(Out::Text(reply.to_string()));
                        });
                    }
                }
                // {"t":"emit"}: fan out to every OTHER connection. The sender's
                // own listeners already got the event via the client-side
                // loopback in transport.ts, mirroring Tauri's app-global emit
                // (matters once the settings window opens a second connection).
                else if v["t"].as_str() == Some("emit") {
                    let event = v["event"].as_str().unwrap_or("").to_string();
                    let payload = v["payload"].clone();
                    let text =
                        json!({"t":"event","event":event,"payload":payload}).to_string();
                    for (cid, out) in state.conns.lock().unwrap().iter() {
                        if *cid != conn_id {
                            let _ = out.send(Out::Text(text.clone()));
                        }
                    }
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    state.unregister_conn(conn_id);
    writer.abort();
    Ok(())
}

/// Commands cheap enough to run inline on the connection's read loop. Keeping
/// these inline preserves their FIFO order relative to each other, which
/// matters most for pty_write (keystrokes must never reorder).
fn is_fast_command(cmd: &str) -> bool {
    matches!(
        cmd,
        "pty_write"
            | "pty_pause"
            | "pty_resume"
            | "pty_resize"
            | "pty_close"
            | "pty_close_all"
            | "pty_shell_label"
            | "pty_has_foreground_process"
            | "get_launch_dir"
            | "workspace_authorize"
            | "workspace_current_dir"
            // LSP/DAP JSON-RPC messages must keep FIFO order per connection;
            // the underlying pipe write is cheap.
            | "lsp_send"
            | "dap_send"
            // SSH keystrokes/resizes are mpsc sends into the shell task — cheap,
            // and their FIFO order matters exactly like pty_write.
            | "ssh_write"
            | "ssh_resize"
            | "ssh_close"
    )
}

async fn dispatch(
    state: &Arc<BridgeState>,
    tx: &OutTx,
    cmd: &str,
    args: Value,
) -> Result<Value, String> {
    match cmd {
        "pty_open" => pty_open(state, tx, args).await,
        "pty_write" => state
            .pty
            .write(u32_arg(&args, "id")?, &str_arg(&args, "data")?)
            .map(|_| Value::Null),
        "pty_pause" => state
            .pty
            .set_paused(u32_arg(&args, "id")?, true)
            .map(|_| Value::Null),
        "pty_resume" => state
            .pty
            .set_paused(u32_arg(&args, "id")?, false)
            .map(|_| Value::Null),
        "pty_resize" => state
            .pty
            .resize(
                u32_arg(&args, "id")?,
                u16_arg(&args, "cols")?,
                u16_arg(&args, "rows")?,
            )
            .map(|_| Value::Null),
        "pty_close" => {
            state.pty.close(u32_arg(&args, "id")?);
            Ok(Value::Null)
        }
        "pty_close_all" => Ok(json!(state.pty.close_all())),
        "pty_shell_label" => state
            .pty
            .shell_label(u32_arg(&args, "id")?)
            .map(|s| json!(s)),
        "pty_has_foreground_process" => state
            .pty
            .has_foreground_process(u32_arg(&args, "id")?)
            .map(|b| json!(b)),
        "workspace_authorize" => {
            let workspace: Option<WorkspaceEnv> = match args.get("workspace") {
                None | Some(Value::Null) => None,
                Some(w) => {
                    Some(serde_json::from_value(w.clone()).map_err(|e| e.to_string())?)
                }
            };
            authorize_workspace_path(&state.registry, &str_arg(&args, "path")?, workspace)
                .map(|s| json!(s))
        }
        "workspace_current_dir" => {
            crate::modules::workspace::workspace_current_dir_impl(&state.registry).map(|s| json!(s))
        }
        "get_launch_dir" => Ok(json!(state.launch_dir.lock().unwrap().take())),

        // ── fs ─────────────────────────────────────────────────────────────
        "fs_read_file" => fs::file::read_file_inner(
            &str_arg(&args, "path")?,
            workspace_arg(&args)?,
            &state.registry,
        )
        .map(to_value),
        "fs_read_file_data_url" => fs::file::read_file_data_url_inner(
            &str_arg(&args, "path")?,
            workspace_arg(&args)?,
            &state.registry,
        )
        .map(to_value),
        "fs_write_file" => {
            let emit = state.event_sink();
            fs::file::write_file_impl(
                &str_arg(&args, "path")?,
                &str_arg(&args, "content")?,
                workspace_arg(&args)?,
                opt_str_arg(&args, "source"),
                &emit,
                &state.registry,
            )
            .map(|_| Value::Null)
        }
        "fs_stat" => {
            fs::file::stat_impl(&str_arg(&args, "path")?, workspace_arg(&args)?, &state.registry)
                .map(to_value)
        }
        "fs_canonicalize" => {
            fs::file::canonicalize_impl(&str_arg(&args, "path")?, workspace_arg(&args)?).map(to_value)
        }
        "fs_read_dir" => fs::tree::fs_read_dir_inner(
            str_arg(&args, "path")?,
            bool_arg(&args, "showHidden")?,
            workspace_arg(&args)?,
            &state.registry,
        )
        .map(to_value),
        "list_subdirs" => fs::tree::list_subdirs_inner(
            str_arg(&args, "path")?,
            bool_arg(&args, "showHidden")?,
            workspace_arg(&args)?,
            &state.registry,
        )
        .map(to_value),
        "fs_create_file" => fs::mutate::create_file_inner(
            &str_arg(&args, "path")?,
            workspace_arg(&args)?,
            &state.registry,
        )
        .map(|_| Value::Null),
        "fs_create_dir" => fs::mutate::create_dir_inner(
            &str_arg(&args, "path")?,
            workspace_arg(&args)?,
            &state.registry,
        )
        .map(|_| Value::Null),
        "fs_rename" => fs::mutate::rename_inner(
            &str_arg(&args, "from")?,
            &str_arg(&args, "to")?,
            workspace_arg(&args)?,
            &state.registry,
        )
        .map(|_| Value::Null),
        "fs_delete" => fs::mutate::delete_inner(
            &str_arg(&args, "path")?,
            workspace_arg(&args)?,
            &state.registry,
        )
        .map(|_| Value::Null),
        "fs_search" => fs::search::fs_search_inner(
            str_arg(&args, "root")?,
            str_arg(&args, "query")?,
            opt_usize_arg(&args, "limit"),
            workspace_arg(&args)?,
            opt_bool_arg(&args, "showHidden"),
            &state.registry,
        )
        .map(to_value),
        "fs_list_files" => fs::search::fs_list_files_inner(
            str_arg(&args, "root")?,
            opt_usize_arg(&args, "limit"),
            opt_usize_arg(&args, "maxDepth"),
            workspace_arg(&args)?,
            opt_bool_arg(&args, "showHidden"),
            &state.registry,
        )
        .map(to_value),
        "fs_grep" => fs::grep::fs_grep_inner(
            str_arg(&args, "pattern")?,
            str_arg(&args, "root")?,
            opt_str_vec_arg(&args, "glob")?,
            opt_bool_arg(&args, "caseInsensitive"),
            opt_usize_arg(&args, "maxResults"),
            workspace_arg(&args)?,
            &state.registry,
        )
        .map(to_value),
        "fs_glob" => fs::grep::fs_glob_inner(
            str_arg(&args, "pattern")?,
            str_arg(&args, "root")?,
            opt_usize_arg(&args, "maxResults"),
            workspace_arg(&args)?,
            &state.registry,
        )
        .map(to_value),
        "fs_watch_add" => {
            let emit = state.event_sink();
            fs::watch::watch_add_impl(
                str_vec_arg(&args, "paths")?,
                workspace_arg(&args)?,
                &emit,
                &state.fs_watch,
                &state.registry,
            )
            .map(|_| Value::Null)
        }
        "fs_watch_remove" => fs::watch::watch_remove_impl(
            str_vec_arg(&args, "paths")?,
            workspace_arg(&args)?,
            &state.fs_watch,
        )
        .map(|_| Value::Null),

        // ── git ────────────────────────────────────────────────────────────
        "git_resolve_repo" => {
            let cwd = str_arg(&args, "cwd")?;
            let ws = WorkspaceEnv::from_option(workspace_arg(&args)?);
            git_op(state, move |r| git_ops::resolve_repo(r, &cwd, &ws).map_err(Into::into)).await
        }
        "git_panel_snapshot" => {
            let cwd = str_arg(&args, "cwd")?;
            let ws = WorkspaceEnv::from_option(workspace_arg(&args)?);
            git_op(state, move |r| git_ops::panel_snapshot(r, &cwd, &ws).map_err(Into::into)).await
        }
        "git_status" => {
            let repo_root = str_arg(&args, "repoRoot")?;
            let ws = WorkspaceEnv::from_option(workspace_arg(&args)?);
            git_op(state, move |r| git_ops::status(r, &repo_root, &ws).map_err(Into::into)).await
        }
        "git_diff" => {
            let repo_root = str_arg(&args, "repoRoot")?;
            let path = opt_str_arg(&args, "path");
            let staged = bool_arg(&args, "staged")?;
            let ws = WorkspaceEnv::from_option(workspace_arg(&args)?);
            git_op(state, move |r| {
                git_ops::diff(r, &repo_root, path.as_deref(), staged, &ws).map_err(Into::into)
            })
            .await
        }
        "git_diff_stat" => {
            let repo_root = str_arg(&args, "repoRoot")?;
            let ws = WorkspaceEnv::from_option(workspace_arg(&args)?);
            git_op(state, move |r| git_ops::diff_stat(r, &repo_root, &ws).map_err(Into::into)).await
        }
        "git_diff_content" => {
            let repo_root = str_arg(&args, "repoRoot")?;
            let path = str_arg(&args, "path")?;
            let staged = bool_arg(&args, "staged")?;
            let original_path = opt_str_arg(&args, "originalPath");
            let ws = WorkspaceEnv::from_option(workspace_arg(&args)?);
            git_op(state, move |r| {
                git_ops::diff_content(r, &repo_root, &path, staged, original_path.as_deref(), &ws)
                    .map_err(Into::into)
            })
            .await
        }
        "git_stage" => {
            let repo_root = str_arg(&args, "repoRoot")?;
            let paths = str_vec_arg(&args, "paths")?;
            let ws = WorkspaceEnv::from_option(workspace_arg(&args)?);
            git_op(state, move |r| {
                git_ops::stage(r, &repo_root, &paths, &ws).map_err(Into::into)
            })
            .await
        }
        "git_unstage" => {
            let repo_root = str_arg(&args, "repoRoot")?;
            let paths = str_vec_arg(&args, "paths")?;
            let ws = WorkspaceEnv::from_option(workspace_arg(&args)?);
            git_op(state, move |r| {
                git_ops::unstage(r, &repo_root, &paths, &ws).map_err(Into::into)
            })
            .await
        }
        "git_discard" => {
            let repo_root = str_arg(&args, "repoRoot")?;
            let entries: Vec<DiscardEntry> = serde_json::from_value(
                args.get("entries").cloned().unwrap_or(Value::Null),
            )
            .map_err(|e| format!("bridge: bad arg entries: {e}"))?;
            let ws = WorkspaceEnv::from_option(workspace_arg(&args)?);
            git_op(state, move |r| {
                git_ops::discard(r, &repo_root, &entries, &ws).map_err(Into::into)
            })
            .await
        }
        "git_commit" => {
            let repo_root = str_arg(&args, "repoRoot")?;
            let message = str_arg(&args, "message")?;
            let ws = WorkspaceEnv::from_option(workspace_arg(&args)?);
            git_op(state, move |r| {
                git_ops::commit(r, &repo_root, &message, &ws).map_err(Into::into)
            })
            .await
        }
        "git_fetch" => {
            let repo_root = str_arg(&args, "repoRoot")?;
            let ws = WorkspaceEnv::from_option(workspace_arg(&args)?);
            git_op(state, move |r| git_ops::fetch(r, &repo_root, &ws).map_err(Into::into)).await
        }
        "git_pull_ff_only" => {
            let repo_root = str_arg(&args, "repoRoot")?;
            let ws = WorkspaceEnv::from_option(workspace_arg(&args)?);
            git_op(state, move |r| {
                git_ops::pull_ff_only(r, &repo_root, &ws).map_err(Into::into)
            })
            .await
        }
        "git_push" => {
            let repo_root = str_arg(&args, "repoRoot")?;
            let ws = WorkspaceEnv::from_option(workspace_arg(&args)?);
            git_op(state, move |r| git_ops::push(r, &repo_root, &ws).map_err(Into::into)).await
        }
        "git_log" => {
            let repo_root = str_arg(&args, "repoRoot")?;
            let limit = opt_u32_arg(&args, "limit").unwrap_or(30);
            let before_sha = opt_str_arg(&args, "beforeSha");
            let ws = WorkspaceEnv::from_option(workspace_arg(&args)?);
            git_op(state, move |r| {
                git_ops::log(r, &repo_root, limit, before_sha.as_deref(), &ws).map_err(Into::into)
            })
            .await
        }
        "git_show_commit" => {
            let repo_root = str_arg(&args, "repoRoot")?;
            let sha = str_arg(&args, "sha")?;
            let ws = WorkspaceEnv::from_option(workspace_arg(&args)?);
            git_op(state, move |r| {
                git_ops::show_commit_diff(r, &repo_root, &sha, &ws).map_err(Into::into)
            })
            .await
        }
        "git_commit_files" => {
            let repo_root = str_arg(&args, "repoRoot")?;
            let sha = str_arg(&args, "sha")?;
            let ws = WorkspaceEnv::from_option(workspace_arg(&args)?);
            git_op(state, move |r| {
                git_ops::commit_files(r, &repo_root, &sha, &ws).map_err(Into::into)
            })
            .await
        }
        "git_commit_file_diff" => {
            let repo_root = str_arg(&args, "repoRoot")?;
            let sha = str_arg(&args, "sha")?;
            let path = str_arg(&args, "path")?;
            let original_path = opt_str_arg(&args, "originalPath");
            let ws = WorkspaceEnv::from_option(workspace_arg(&args)?);
            git_op(state, move |r| {
                git_ops::commit_file_diff(r, &repo_root, &sha, &path, original_path.as_deref(), &ws)
                    .map_err(Into::into)
            })
            .await
        }
        "git_list_branches" => {
            let repo_root = str_arg(&args, "repoRoot")?;
            let ws = WorkspaceEnv::from_option(workspace_arg(&args)?);
            git_op(state, move |r| {
                git_ops::list_branches(r, &repo_root, &ws).map_err(Into::into)
            })
            .await
        }
        "git_checkout_branch" => {
            let repo_root = str_arg(&args, "repoRoot")?;
            let branch = str_arg(&args, "branch")?;
            let create = bool_arg(&args, "create")?;
            let ws = WorkspaceEnv::from_option(workspace_arg(&args)?);
            git_op(state, move |r| {
                git_ops::checkout_branch(r, &repo_root, &branch, create, &ws).map_err(Into::into)
            })
            .await
        }
        "git_remote_url" => {
            let repo_root = str_arg(&args, "repoRoot")?;
            let remote = opt_str_arg(&args, "name").unwrap_or_else(|| "origin".to_string());
            let ws = WorkspaceEnv::from_option(workspace_arg(&args)?);
            git_op(state, move |r| {
                git_ops::remote_url(r, &repo_root, &remote, &ws).map_err(Into::into)
            })
            .await
        }

        // ── shell ──────────────────────────────────────────────────────────
        "shell_run_command" => {
            let command = str_arg(&args, "command")?;
            let cwd = opt_str_arg(&args, "cwd");
            let timeout_secs = opt_u64_arg(&args, "timeoutSecs");
            let ws = WorkspaceEnv::from_option(workspace_arg(&args)?);
            let state = Arc::clone(state);
            tokio::task::spawn_blocking(move || {
                shell::run_command_impl(command, cwd, timeout_secs, ws, &state.registry)
            })
            .await
            .map_err(|e| e.to_string())?
            .map(to_value)
        }
        "shell_session_open" => state
            .shell
            .session_open(&state.registry, opt_str_arg(&args, "cwd"), workspace_arg(&args)?)
            .map(|id| json!(id)),
        "shell_session_run" => {
            let id = u32_arg(&args, "id")?;
            let command = str_arg(&args, "command")?;
            let cwd = opt_str_arg(&args, "cwd");
            let timeout_secs = opt_u64_arg(&args, "timeoutSecs");
            let ws = workspace_arg(&args)?;
            let state = Arc::clone(state);
            tokio::task::spawn_blocking(move || {
                state
                    .shell
                    .session_run(&state.registry, id, command, cwd, timeout_secs, ws)
            })
            .await
            .map_err(|e| e.to_string())?
            .map(to_value)
        }
        "shell_session_close" => {
            state.shell.session_close(u32_arg(&args, "id")?);
            Ok(Value::Null)
        }
        "shell_bg_spawn" => state
            .shell
            .bg_spawn(
                &state.registry,
                str_arg(&args, "command")?,
                opt_str_arg(&args, "cwd"),
                workspace_arg(&args)?,
            )
            .map(|id| json!(id)),
        "shell_bg_logs" => state
            .shell
            .bg_logs(u32_arg(&args, "handle")?, opt_u64_arg(&args, "sinceOffset"))
            .map(to_value),
        "shell_bg_kill" => {
            state.shell.bg_kill(u32_arg(&args, "handle")?);
            Ok(Value::Null)
        }
        "shell_bg_list" => Ok(to_value(state.shell.bg_list())),

        // ── secrets ────────────────────────────────────────────────────────
        "secrets_get" => secrets::secrets_get_impl(
            &state.secrets,
            &app_local_data_dir()?,
            &str_arg(&args, "service")?,
            &str_arg(&args, "account")?,
        )
        .map(to_value),
        "secrets_set" => secrets::secrets_set_impl(
            &state.secrets,
            &app_local_data_dir()?,
            &str_arg(&args, "service")?,
            &str_arg(&args, "account")?,
            str_arg(&args, "password")?,
        )
        .map(|_| Value::Null),
        "secrets_delete" => secrets::secrets_delete_impl(
            &state.secrets,
            &app_local_data_dir()?,
            &str_arg(&args, "service")?,
            &str_arg(&args, "account")?,
        )
        .map(|_| Value::Null),
        "secrets_get_all" => secrets::secrets_get_all_impl(
            &state.secrets,
            &app_local_data_dir()?,
            &str_arg(&args, "service")?,
            str_vec_arg(&args, "accounts")?,
        )
        .map(to_value),

        // ── extensions ─────────────────────────────────────────────────────
        "extensions_list" => {
            extensions::extensions_list_impl(&app_local_data_dir()?).map(to_value)
        }
        "extensions_dir_path" => {
            extensions::extensions_dir_path_impl(&app_local_data_dir()?).map(|s| json!(s))
        }
        "extensions_write" => extensions::extensions_write_impl(
            &app_local_data_dir()?,
            str_arg(&args, "id")?,
            str_arg(&args, "manifest")?,
            opt_str_map_arg(&args, "files")?,
        )
        .map(|_| Value::Null),
        "extensions_read_file" => extensions::extensions_read_file_impl(
            &app_local_data_dir()?,
            str_arg(&args, "folder")?,
            str_arg(&args, "file")?,
        )
        .map(|s| json!(s)),
        "extensions_uninstall" => {
            extensions::extensions_uninstall_impl(&app_local_data_dir()?, str_arg(&args, "folder")?)
                .map(|_| Value::Null)
        }
        "extensions_fetch_text" => extensions::extensions_fetch_text(str_arg(&args, "url")?)
            .await
            .map(|s| json!(s)),

        // ── ssh ────────────────────────────────────────────────────────────
        "ssh_connect" => {
            let config: ssh::ConnectConfig = serde_json::from_value(args["config"].clone())
                .map_err(|e| format!("ssh_connect config: {e}"))?;
            ssh::ssh_connect_impl(&state.ssh, conn_event_sink(tx), config)
                .await
                .map(|id| json!(id))
        }
        "ssh_open_shell" => {
            let on_data: ChanRef = serde_json::from_value(args["onData"].clone())
                .map_err(|e| format!("ssh_open_shell onData: {e}"))?;
            let on_exit: ChanRef = serde_json::from_value(args["onExit"].clone())
                .map_err(|e| format!("ssh_open_shell onExit: {e}"))?;
            let tx_data = tx.clone();
            let data_sink: session::DataSink = Arc::new(move |bytes: Vec<u8>| {
                let mut framed = Vec::with_capacity(4 + bytes.len());
                framed.extend_from_slice(&on_data.id.to_le_bytes());
                framed.extend_from_slice(&bytes);
                tx_data.send(Out::Bin(framed)).is_ok()
            });
            let tx_exit = tx.clone();
            let exit_sink: session::ExitSink = Box::new(move |code| {
                let _ = tx_exit.send(Out::Text(
                    json!({"t":"chan","chan":on_exit.id,"value":code}).to_string(),
                ));
            });
            ssh::ssh_open_shell_impl(
                &state.ssh,
                u32_arg(&args, "connId")?,
                u16_arg(&args, "cols")?,
                u16_arg(&args, "rows")?,
                data_sink,
                exit_sink,
            )
            .await
            .map(|id| json!(id))
        }
        "ssh_write" => {
            ssh::ssh_write_impl(&state.ssh, u32_arg(&args, "id")?, str_arg(&args, "data")?)
                .await
                .map(|_| Value::Null)
        }
        "ssh_resize" => ssh::ssh_resize_impl(
            &state.ssh,
            u32_arg(&args, "id")?,
            u16_arg(&args, "cols")?,
            u16_arg(&args, "rows")?,
        )
        .await
        .map(|_| Value::Null),
        "ssh_close" => ssh::ssh_close_impl(&state.ssh, u32_arg(&args, "id")?)
            .await
            .map(|_| Value::Null),
        "ssh_disconnect" => ssh::ssh_disconnect_impl(&state.ssh, u32_arg(&args, "connId")?)
            .await
            .map(|_| Value::Null),
        "ssh_known_host_decision" => ssh::ssh_known_host_decision_impl(
            &state.ssh,
            u32_arg(&args, "connId")?,
            bool_arg(&args, "accept")?,
        )
        .await
        .map(|_| Value::Null),
        "ssh_sftp_list" => {
            ssh::ssh_sftp_list_impl(&state.ssh, u32_arg(&args, "connId")?, str_arg(&args, "path")?)
                .await
                .map(to_value)
        }
        "ssh_sftp_read" => {
            ssh::ssh_sftp_read_impl(&state.ssh, u32_arg(&args, "connId")?, str_arg(&args, "path")?)
                .await
                .map(|s| json!(s))
        }
        "ssh_sftp_write" => ssh::ssh_sftp_write_impl(
            &state.ssh,
            u32_arg(&args, "connId")?,
            str_arg(&args, "path")?,
            str_arg(&args, "contents")?,
        )
        .await
        .map(|_| Value::Null),
        "ssh_sftp_download" => ssh::ssh_sftp_download_impl(
            &state.ssh,
            &state.registry,
            u32_arg(&args, "connId")?,
            str_arg(&args, "remote")?,
            str_arg(&args, "local")?,
        )
        .await
        .map(|_| Value::Null),
        "ssh_sftp_download_dir" => ssh::ssh_sftp_download_dir_impl(
            &state.ssh,
            &state.registry,
            conn_event_sink(tx),
            u32_arg(&args, "connId")?,
            u32_arg(&args, "opId")?,
            str_arg(&args, "remote")?,
            str_arg(&args, "local")?,
        )
        .await
        .map(to_value),
        "ssh_sftp_upload" => ssh::ssh_sftp_upload_impl(
            &state.ssh,
            &state.registry,
            u32_arg(&args, "connId")?,
            str_arg(&args, "local")?,
            str_arg(&args, "remote")?,
        )
        .await
        .map(|_| Value::Null),
        "ssh_sftp_mkdir" => {
            ssh::ssh_sftp_mkdir_impl(&state.ssh, u32_arg(&args, "connId")?, str_arg(&args, "path")?)
                .await
                .map(|_| Value::Null)
        }
        "ssh_sftp_rename" => ssh::ssh_sftp_rename_impl(
            &state.ssh,
            u32_arg(&args, "connId")?,
            str_arg(&args, "from")?,
            str_arg(&args, "to")?,
        )
        .await
        .map(|_| Value::Null),
        "ssh_sftp_delete" => ssh::ssh_sftp_delete_impl(
            &state.ssh,
            u32_arg(&args, "connId")?,
            str_arg(&args, "path")?,
            bool_arg(&args, "isDir")?,
        )
        .await
        .map(|_| Value::Null),

        // ── lsp ────────────────────────────────────────────────────────────
        "lsp_start" => {
            let sink = chan_sink(tx, &args, "onMessage")?;
            lsp::lsp_start_impl(
                &state.lsp,
                &state.registry,
                str_arg(&args, "languageId")?,
                str_arg(&args, "command")?,
                str_vec_arg(&args, "args")?,
                opt_str_arg(&args, "cwd"),
                sink,
            )
            .await
            .map(|id| json!(id))
        }
        "lsp_send" => {
            lsp::lsp_send_impl(&state.lsp, u32_arg(&args, "id")?, str_arg(&args, "message")?)
                .map(|_| Value::Null)
        }
        "lsp_stop" => lsp::lsp_stop_impl(&state.lsp, u32_arg(&args, "id")?).map(|_| Value::Null),
        "lsp_stop_all" => lsp::lsp_stop_all_impl(&state.lsp).map(|n| json!(n)),
        "lsp_install_dir" => lsp::lsp_install_dir_impl(&app_local_data_dir()?).map(|s| json!(s)),
        "lsp_install_list" => lsp::lsp_install_list_impl(&app_local_data_dir()?).map(to_value),
        "lsp_install_uninstall" => {
            lsp::lsp_install_uninstall_impl(&app_local_data_dir()?, str_arg(&args, "serverId")?)
                .map(|_| Value::Null)
        }
        "lsp_install_download" => {
            let chan: ChanRef = serde_json::from_value(args["onProgress"].clone())
                .map_err(|e| format!("lsp_install_download onProgress: {e}"))?;
            let tx_p = tx.clone();
            let sink: lsp::ProgressSink = Box::new(move |p| {
                let _ = tx_p.send(Out::Text(
                    json!({"t":"chan","chan":chan.id,"value":to_value(p)}).to_string(),
                ));
            });
            lsp::lsp_install_download_impl(
                &app_local_data_dir()?,
                str_arg(&args, "serverId")?,
                str_arg(&args, "url")?,
                str_arg(&args, "archive")?,
                str_arg(&args, "binName")?,
                str_arg(&args, "version")?,
                sink,
            )
            .await
            .map(|s| json!(s))
        }

        // ── dap ────────────────────────────────────────────────────────────
        "dap_start" => {
            let sink = chan_sink(tx, &args, "onMessage")?;
            dap::dap_start_impl(
                &state.dap,
                &state.registry,
                str_arg(&args, "command")?,
                str_vec_arg(&args, "args")?,
                opt_str_arg(&args, "cwd"),
                sink,
            )
            .await
            .map(|id| json!(id))
        }
        "dap_send" => {
            dap::dap_send_impl(&state.dap, u32_arg(&args, "id")?, str_arg(&args, "message")?)
                .map(|_| Value::Null)
        }
        "dap_stop" => dap::dap_stop_impl(&state.dap, u32_arg(&args, "id")?).map(|_| Value::Null),
        "dap_stop_all" => dap::dap_stop_all_impl(&state.dap).map(|n| json!(n)),

        // ── agent / cli ────────────────────────────────────────────────────
        "agent_enable_claude_hooks" => {
            crate::modules::agent::agent_enable_claude_hooks().map(|_| Value::Null)
        }
        "agent_claude_hooks_status" => Ok(json!(crate::modules::agent::agent_claude_hooks_status())),
        "arterm_cli_list_sessions" => {
            Ok(to_value(crate::modules::arterm_cli::arterm_cli_list_sessions()))
        }

        // ── wsl (Windows-only; Linux fallbacks live in workspace.rs) ───────
        "wsl_list_distros" => crate::modules::workspace::wsl_list_distros().await.map(to_value),
        "wsl_default_distro" => crate::modules::workspace::wsl_default_distro()
            .await
            .map(to_value),
        "wsl_home" => {
            crate::modules::workspace::wsl_home(str_arg(&args, "distro")?).map(|s| json!(s))
        }

        // ── net ────────────────────────────────────────────────────────────
        "lm_ping" => net::lm_ping(str_arg(&args, "baseUrl")?).await.map(|s| json!(s)),
        "ai_http_request" => net::ai_http_request(
            str_arg(&args, "url")?,
            str_arg(&args, "method")?,
            opt_str_map_arg(&args, "headers")?,
            opt_bytes_arg(&args, "body")?,
            opt_bool_arg(&args, "allowPrivateNetwork"),
        )
        .await
        .map(to_value),
        "ai_http_stream" => {
            let chan: ChanRef = serde_json::from_value(args["onEvent"].clone())
                .map_err(|e| format!("ai_http_stream onEvent: {e}"))?;
            let tx_ev = tx.clone();
            let sink: net::AiStreamSink = Box::new(move |ev| {
                tx_ev
                    .send(Out::Text(
                        json!({"t":"chan","chan":chan.id,"value":to_value(ev)}).to_string(),
                    ))
                    .is_ok()
            });
            net::ai_http_stream_impl(
                str_arg(&args, "url")?,
                str_arg(&args, "method")?,
                opt_str_map_arg(&args, "headers")?,
                opt_bytes_arg(&args, "body")?,
                opt_bool_arg(&args, "allowPrivateNetwork"),
                sink,
            )
            .await
            .map(|_| Value::Null)
        }

        _ => Err(format!("bridge: command not implemented yet: {cmd}")),
    }
}

async fn git_op<F, T>(state: &Arc<BridgeState>, f: F) -> Result<Value, String>
where
    F: FnOnce(&WorkspaceRegistry) -> Result<T, String> + Send + 'static,
    T: serde::Serialize + Send + 'static,
{
    let state = Arc::clone(state);
    tokio::task::spawn_blocking(move || f(&state.registry))
        .await
        .map_err(|e| e.to_string())?
        .map(to_value)
}

async fn pty_open(state: &Arc<BridgeState>, tx: &OutTx, args: Value) -> Result<Value, String> {
    #[derive(Deserialize)]
    struct OpenArgs {
        cols: u16,
        rows: u16,
        cwd: Option<String>,
        workspace: Option<WorkspaceEnv>,
        #[serde(rename = "onData")]
        on_data: ChanRef,
        #[serde(rename = "onExit")]
        on_exit: ChanRef,
    }
    let a: OpenArgs = serde_json::from_value(args).map_err(|e| format!("pty_open args: {e}"))?;
    let workspace = WorkspaceEnv::from_option(a.workspace);
    authorize_user_spawn_cwd(&state.registry, a.cwd.as_deref(), &workspace).map_err(|e| {
        eprintln!("bridge: pty_open cwd rejected: {e}");
        e
    })?;
    let id = state.pty.alloc_id();

    let data_chan = a.on_data.id;
    let tx_data = tx.clone();
    let on_data: session::DataSink = Arc::new(move |bytes: Vec<u8>| {
        let mut framed = Vec::with_capacity(4 + bytes.len());
        framed.extend_from_slice(&data_chan.to_le_bytes());
        framed.extend_from_slice(&bytes);
        tx_data.send(Out::Bin(framed)).is_ok()
    });
    let exit_chan = a.on_exit.id;
    let tx_exit = tx.clone();
    let on_exit: session::ExitSink = Box::new(move |code| {
        let _ = tx_exit.send(Out::Text(
            json!({"t":"chan","chan":exit_chan,"value":code}).to_string(),
        ));
    });
    let tx_ev = tx.clone();
    let emit: session::EventSink = Arc::new(move |event, payload| {
        let _ = tx_ev.send(Out::Text(
            json!({"t":"event","event":event,"payload":payload}).to_string(),
        ));
    });

    let (cols, rows, cwd) = (a.cols, a.rows, a.cwd);
    let session = tokio::task::spawn_blocking(move || {
        session::spawn(id, emit, cols, rows, cwd, workspace, on_data, on_exit).map(|(s, _)| s)
    })
    .await
    .map_err(|e| e.to_string())??;
    state.pty.insert(id, session);
    eprintln!("bridge: pty opened id={id} cols={cols} rows={rows}");
    Ok(json!(id))
}

#[derive(Deserialize)]
struct ChanRef {
    #[serde(rename = "__arterm_chan__")]
    id: u32,
}

/// Event sink scoped to one WebSocket connection, mirroring Tauri's
/// `AppHandle::emit` for command flows whose events only matter to the
/// requesting client (SSH host-key prompts, SFTP progress).
fn conn_event_sink(tx: &OutTx) -> EventSink {
    let tx = tx.clone();
    Arc::new(move |event: &str, payload: Value| {
        let _ = tx.send(Out::Text(
            json!({"t":"event","event":event,"payload":payload}).to_string(),
        ));
    })
}

/// Build a `MessageSink` that forwards strings to the client-side `Channel`
/// referenced by `args[key]`, mirroring Tauri's `Channel<String>`.
fn chan_sink(tx: &OutTx, args: &Value, key: &str) -> Result<MessageSink, String> {
    let chan: ChanRef = serde_json::from_value(args[key].clone())
        .map_err(|e| format!("bridge: bad chan arg {key}: {e}"))?;
    let tx = tx.clone();
    Ok(Box::new(move |msg: String| {
        tx.send(Out::Text(
            json!({"t":"chan","chan":chan.id,"value":msg}).to_string(),
        ))
        .is_ok()
    }))
}

fn u32_arg(args: &Value, key: &str) -> Result<u32, String> {
    args[key]
        .as_u64()
        .and_then(|v| u32::try_from(v).ok())
        .ok_or_else(|| format!("bridge: bad arg {key}"))
}

fn u16_arg(args: &Value, key: &str) -> Result<u16, String> {
    args[key]
        .as_u64()
        .and_then(|v| u16::try_from(v).ok())
        .ok_or_else(|| format!("bridge: bad arg {key}"))
}

fn str_arg(args: &Value, key: &str) -> Result<String, String> {
    args[key]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| format!("bridge: bad arg {key}"))
}

/// Frontend sends absent optionals as JSON `null`; treat both as `None`.
fn opt_str_arg(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(str::to_string)
}

fn bool_arg(args: &Value, key: &str) -> Result<bool, String> {
    args.get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| format!("bridge: bad arg {key}"))
}

fn opt_bool_arg(args: &Value, key: &str) -> Option<bool> {
    args.get(key).and_then(Value::as_bool)
}

fn opt_usize_arg(args: &Value, key: &str) -> Option<usize> {
    args.get(key).and_then(Value::as_u64).map(|v| v as usize)
}

fn opt_u32_arg(args: &Value, key: &str) -> Option<u32> {
    args.get(key)
        .and_then(Value::as_u64)
        .and_then(|v| u32::try_from(v).ok())
}

fn opt_u64_arg(args: &Value, key: &str) -> Option<u64> {
    args.get(key).and_then(Value::as_u64)
}

fn str_vec_arg(args: &Value, key: &str) -> Result<Vec<String>, String> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(Value::Null))
        .map_err(|e| format!("bridge: bad arg {key}: {e}"))
}

fn opt_str_vec_arg(args: &Value, key: &str) -> Result<Option<Vec<String>>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => serde_json::from_value(v.clone())
            .map(Some)
            .map_err(|e| format!("bridge: bad arg {key}: {e}")),
    }
}

fn opt_bytes_arg(args: &Value, key: &str) -> Result<Option<Vec<u8>>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => serde_json::from_value(v.clone())
            .map(Some)
            .map_err(|e| format!("bridge: bad arg {key}: {e}")),
    }
}

fn opt_str_map_arg(args: &Value, key: &str) -> Result<Option<HashMap<String, String>>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => serde_json::from_value(v.clone())
            .map(Some)
            .map_err(|e| format!("bridge: bad arg {key}: {e}")),
    }
}

fn workspace_arg(args: &Value) -> Result<Option<WorkspaceEnv>, String> {
    match args.get("workspace") {
        None | Some(Value::Null) => Ok(None),
        Some(w) => serde_json::from_value(w.clone())
            .map(Some)
            .map_err(|e| format!("bridge: bad workspace arg: {e}")),
    }
}

fn to_value<T: serde::Serialize>(value: T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

/// Localhost-only auth token. Not cryptographic-grade randomness, but each
/// `RandomState` carries a fresh per-process random key, which is enough to
/// keep other local users from guessing the URL of a loopback socket.
fn gen_token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut h1 = RandomState::new().build_hasher();
    h1.write_u64(std::process::id() as u64);
    let a = h1.finish();
    let mut h2 = RandomState::new().build_hasher();
    h2.write_u64(a);
    format!("{a:016x}{:016x}", h2.finish())
}
