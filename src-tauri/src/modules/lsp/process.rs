//! Spawns a language server as a long-lived stdio child and streams its
//! framed stdout messages back to the frontend. Models the pty `session.rs`
//! thread layout (reader + waiter) but over plain pipes, not a PTY.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use shared_child::SharedChild;
use tauri::ipc::Channel;

use crate::modules::proto::framing::{self, FrameParser};

const READ_BUF: usize = 16 * 1024;

pub struct LspServer {
    // Drop order matches pty::Session: on Windows close the Job HANDLE first so
    // KILL_ON_JOB_CLOSE reaps the whole server subtree (e.g. tsserver spawned by
    // typescript-language-server) before we drop our own handles.
    #[cfg(windows)]
    _job: Option<crate::modules::pty::PtyJob>,
    pub pid: u32,
    child: Arc<SharedChild>,
    stdin: Arc<Mutex<ChildStdin>>,
}

impl LspServer {
    pub fn send(&self, message: &str) -> Result<(), String> {
        let framed = framing::encode(message);
        let mut w = self
            .stdin
            .lock()
            .map_err(|_| "lsp stdin poisoned".to_string())?;
        w.write_all(&framed).map_err(|e| e.to_string())?;
        w.flush().map_err(|e| e.to_string())
    }

    pub fn kill(&self) {
        if let Err(e) = self.child.kill() {
            log::debug!("lsp kill returned: {e}");
        }
    }
}

impl Drop for LspServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

pub fn spawn(
    program: &str,
    args: &[String],
    cwd: Option<PathBuf>,
    on_message: Channel<String>,
) -> Result<LspServer, String> {
    let resolved = resolve_program(program)?;
    let mut cmd = Command::new(&resolved);
    cmd.args(args);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::modules::proc::hide_console(&mut cmd);

    let child = Arc::new(SharedChild::spawn(&mut cmd).map_err(|e| {
        log::warn!("lsp spawn failed program={program}: {e}");
        format!("failed to start language server '{program}': {e}")
    })?);
    let pid = child.id();

    let stdin = child
        .take_stdin()
        .ok_or_else(|| reap(&child, "no stdin pipe"))?;
    let mut stdout = child
        .take_stdout()
        .ok_or_else(|| reap(&child, "no stdout pipe"))?;
    let mut stderr = child
        .take_stderr()
        .ok_or_else(|| reap(&child, "no stderr pipe"))?;

    #[cfg(windows)]
    let job = match crate::modules::pty::PtyJob::create_for(pid) {
        Ok(j) => Some(j),
        Err(e) => {
            log::warn!("lsp job-object setup failed for pid={pid}: {e}");
            None
        }
    };

    thread::Builder::new()
        .name(format!("arterm-lsp-reader-{pid}"))
        .spawn(move || {
            let mut buf = [0u8; READ_BUF];
            let mut parser = FrameParser::new();
            loop {
                match stdout.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        parser.push(&buf[..n]);
                        loop {
                            match parser.next_message() {
                                Some(Ok(msg)) => {
                                    if on_message.send(msg).is_err() {
                                        return; // frontend went away
                                    }
                                }
                                Some(Err(e)) => {
                                    log::warn!("lsp framing error pid={pid}: {e:?}");
                                }
                                None => break,
                            }
                        }
                    }
                    Err(e) => {
                        log::debug!("lsp reader ended pid={pid}: {e}");
                        break;
                    }
                }
            }
        })
        .map_err(|e| reap(&child, &e.to_string()))?;

    // Language servers narrate progress and errors on stderr; surface it in the
    // app log instead of letting the pipe fill and block the child.
    thread::Builder::new()
        .name(format!("arterm-lsp-stderr-{pid}"))
        .spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match stderr.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let text = String::from_utf8_lossy(&buf[..n]);
                        for line in text.lines().filter(|l| !l.trim().is_empty()) {
                            log::debug!("lsp[{pid}] {line}");
                        }
                    }
                }
            }
        })
        .ok();

    let waiter = Arc::clone(&child);
    thread::Builder::new()
        .name(format!("arterm-lsp-waiter-{pid}"))
        .spawn(move || match waiter.wait() {
            Ok(status) => log::info!("lsp exited pid={pid} status={status:?}"),
            Err(e) => log::warn!("lsp wait failed pid={pid}: {e}"),
        })
        .ok();

    log::info!("lsp started program={program} pid={pid}");
    Ok(LspServer {
        #[cfg(windows)]
        _job: job,
        pid,
        child,
        stdin: Arc::new(Mutex::new(stdin)),
    })
}

fn reap(child: &SharedChild, msg: &str) -> String {
    let _ = child.kill();
    msg.to_string()
}

// On Unix `Command` resolves bare names through PATH. On Windows it only
// appends `.exe`, so npm-installed servers shipped as `.cmd`/`.bat` shims
// (typescript-language-server, pyright-langserver, ...) won't be found. Walk
// PATH + PATHEXT ourselves to locate them, avoiding cmd.exe quoting hazards.
#[cfg(windows)]
fn resolve_program(program: &str) -> Result<PathBuf, String> {
    let candidate = PathBuf::from(program);
    if candidate.is_absolute() || program.contains(['/', '\\']) {
        return Ok(candidate);
    }
    if PathBuf::from(program).extension().is_some() && candidate.exists() {
        return Ok(candidate);
    }
    let exts: Vec<String> = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
        .split(';')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let paths = std::env::var_os("PATH").ok_or_else(|| "PATH not set".to_string())?;
    // Prefer PATHEXT variants (.cmd/.bat/.exe) across all PATH dirs first. An
    // extensionless match is usually a Unix shell shim (npm ships both next to
    // each other), which CreateProcess can't execute — it fails with "%1 is not
    // a valid Win32 application" (os error 193). Only fall back to it last.
    for dir in std::env::split_paths(&paths) {
        for ext in &exts {
            let with_ext = dir.join(format!("{program}{ext}"));
            if with_ext.is_file() {
                return Ok(with_ext);
            }
        }
    }
    for dir in std::env::split_paths(&paths) {
        let direct = dir.join(program);
        if direct.is_file() {
            return Ok(direct);
        }
    }
    Err(format!("language server '{program}' not found on PATH"))
}

#[cfg(not(windows))]
fn resolve_program(program: &str) -> Result<PathBuf, String> {
    Ok(PathBuf::from(program))
}
