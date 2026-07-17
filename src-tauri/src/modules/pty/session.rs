use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, ChildKiller, MasterPty, PtySize};

use super::agent_detect::AgentDetector;
use super::command_detect::CommandDetector;
use super::da_filter::DaFilter;
use super::shell_init;
use crate::modules::workspace::WorkspaceEnv;

const AGENT_EVENT: &str = "arterm:agent-signal";
const COMMAND_EVENT: &str = "arterm:command-error";

/// Shell-agnostic output sinks. The Tauri command layer wraps IPC `Channel`s
/// and `AppHandle::emit`; the Electron bridge wraps WebSocket senders. A
/// `DataSink` returns false once the far side is gone so the flusher can exit.
pub type DataSink = Arc<dyn Fn(Vec<u8>) -> bool + Send + Sync>;
pub type ExitSink = Box<dyn FnOnce(i32) + Send>;
pub type EventSink = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;

fn to_event_payload<T: serde::Serialize>(value: T) -> serde_json::Value {
    serde_json::to_value(value).unwrap_or(serde_json::Value::Null)
}

// Flusher coalesces a short window after first-byte arrival so we send chunks,
// not single bytes. MAX_IDLE is only a safety net for missed signals.
const FLUSH_COALESCE: Duration = Duration::from_millis(4);
const FLUSH_MAX_IDLE: Duration = Duration::from_millis(50);
const READ_BUF: usize = 16 * 1024;
// Cap on buffered-but-not-yet-flushed bytes. On overflow we discard the
// entire pending buffer and emit an SGR-reset + notice in its place.
// Dropping a partial prefix would slice a CSI sequence in half and corrupt
// xterm's screen state. 4 MiB is ~1000 full 80x24 screens.
const MAX_PENDING: usize = 4 * 1024 * 1024;
// Hard reset (ESC c) + dim notice. Written verbatim into the stream when
// we're forced to discard backlog.
const OVERFLOW_NOTICE: &[u8] =
    b"\x1bc\x1b[2m[arterm: dropped output due to backpressure]\x1b[0m\r\n";
// Tick for the reader's backpressure park and the flusher's idle wait.
const BACKPRESSURE_TICK: Duration = Duration::from_millis(100);
// Max bytes handed to the frontend per flush send, so a resume burst can't
// dump the whole backlog into a single xterm.write call.
const FLUSH_CHUNK: usize = 128 * 1024;
// When over cap but NOT paused, park at most this many ticks waiting for the
// flusher to make room before falling back to the discard safety-net. Absorbs
// the brief window right after a resume where the buffer is still near-full.
const OVERFLOW_GRACE_TICKS: u32 = 3;

/// Reader→flusher hand-off buffer plus the frontend's flow-control pause flag.
/// Both live under one mutex (paired with the session's Condvar) so a pause
/// toggled from a Tauri command can never race a wakeup / lose a notify.
struct Pending {
    buf: Vec<u8>,
    /// Set by pty_pause / pty_resume. While true the flusher stops sending and
    /// the reader lets the buffer fill to MAX_PENDING then blocks, which
    /// backpressures the child through the kernel PTY buffer (zero data loss).
    paused: bool,
}

impl Pending {
    fn new() -> Self {
        Self {
            buf: Vec::with_capacity(READ_BUF),
            paused: false,
        }
    }
}

pub struct Session {
    // Field drop order is intentional. Rust drops fields top-to-bottom:
    //   1. `_job` — on Windows, closing the Job HANDLE fires
    //      KILL_ON_JOB_CLOSE, terminating the pwsh tree before the master
    //      pipe drops. Without this, ClosePseudoConsole in `master`'s Drop
    //      can block waiting for conhost to drain pending output, freezing
    //      the Tauri worker thread that triggered the close.
    //   2. `killer` — best-effort kill (redundant on Windows once Job
    //      closed, but harmless and required on Unix where there is no Job).
    //   3. `writer` — closes the input side of the master pipe.
    //   4. `master` — last; ClosePseudoConsole on Windows. By now the child
    //      is dead and conhost has nothing left to drain.
    #[cfg(windows)]
    _job: Option<super::job::PtyJob>,
    /// PID of the shell process. 0 means unknown; callers must skip checks when 0.
    pub shell_pid: u32,
    /// Shell kind label ("pwsh", "bash", …) — queried by the frontend so AI
    /// features can generate shell-correct syntax.
    pub shell_label: &'static str,
    pub killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub master: Mutex<Box<dyn MasterPty + Send>>,
    // Reader→flusher buffer + flow-control pause flag, shared with the spawned
    // reader/flusher/waiter threads. Held here so pty_pause / pty_resume can
    // toggle backpressure. Dropping this Arc only decrefs — the threads keep
    // their own clones — so it needs no place in the drop-order dance above.
    flow: Arc<(Mutex<Pending>, Condvar)>,
}

impl Session {
    /// Toggle frontend flow control. When paused the flusher stops draining and
    /// the child is backpressured through the kernel PTY buffer; when resumed
    /// the flusher (and any reader parked on the cap) wakes and drains.
    ///
    /// Idempotent: a redundant pause/resume (same state) is a no-op and skips
    /// the wakeup, so double-pause or resume-when-running can't wedge anything.
    pub fn set_flow_paused(&self, paused: bool) {
        let (lock, cv) = &*self.flow;
        let mut g = lock.lock().unwrap();
        if g.paused == paused {
            return;
        }
        g.paused = paused;
        drop(g);
        cv.notify_all();
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        // If the session Arc is dropped without an explicit pty_close (e.g.
        // frontend disconnected, window crashed, dev HMR), the reader/flusher
        // threads would otherwise stay alive forever holding the child. Kill
        // the child here so the reader hits EOF and the threads unwind.
        if let Ok(mut k) = self.killer.lock() {
            let _ = k.kill();
        }
    }
}
// Serializes ConPTY create and close: overlapping pseudoconsole lifecycle
// calls corrupt the new console so its shell never pumps output (issue #356).
#[cfg(windows)]
static CONPTY_LIFECYCLE_LOCK: Mutex<()> = Mutex::new(());

pub(super) fn drop_session(session: Arc<Session>) {
    #[cfg(windows)]
    let _guard = CONPTY_LIFECYCLE_LOCK.lock().unwrap();
    drop(session);
}

struct ChildKillGuard {
    killer: Option<Box<dyn ChildKiller + Send + Sync>>,
}

impl ChildKillGuard {
    fn new(killer: Box<dyn ChildKiller + Send + Sync>) -> Self {
        Self {
            killer: Some(killer),
        }
    }

    fn disarm(&mut self) {
        self.killer = None;
    }
}

impl Drop for ChildKillGuard {
    fn drop(&mut self) {
        if let Some(mut k) = self.killer.take() {
            let _ = k.kill();
        }
    }
}

/// Append `filtered` to the pending buffer, applying backpressure.
///
/// While the buffer would exceed MAX_PENDING we park on the condvar (dropping
/// the lock so the flusher can drain). If the frontend has paused us this parks
/// until it resumes, the session ends, or room appears — the kernel PTY buffer
/// fills and the child blocks on write, so nothing is lost. If we're NOT paused
/// and the flusher still hasn't made room after OVERFLOW_GRACE_TICKS (no
/// consumer is keeping up, e.g. a session without frontend flow control), fall
/// back to the original safety-net: discard the backlog and inject an ESC c
/// reset so a half-written CSI sequence can't corrupt xterm's screen state.
fn push_with_backpressure(
    pending: &(Mutex<Pending>, Condvar),
    filtered: &[u8],
    done: &AtomicBool,
    dropped_bytes: &mut u64,
) {
    let (lock, cv) = pending;
    let mut g = lock.lock().unwrap();
    let mut idle_ticks = 0u32;
    while g.buf.len() + filtered.len() > MAX_PENDING && !done.load(Ordering::Acquire) {
        if g.paused {
            idle_ticks = 0;
        } else if idle_ticks >= OVERFLOW_GRACE_TICKS {
            break;
        } else {
            idle_ticks += 1;
        }
        let (next, _) = cv.wait_timeout(g, BACKPRESSURE_TICK).unwrap();
        g = next;
    }
    if g.buf.len() + filtered.len() > MAX_PENDING && !g.paused && !done.load(Ordering::Acquire) {
        *dropped_bytes += g.buf.len() as u64;
        g.buf.clear();
        g.buf.extend_from_slice(OVERFLOW_NOTICE);
    }
    g.buf.extend_from_slice(filtered);
    cv.notify_one();
}

#[allow(clippy::too_many_arguments)]
pub fn spawn(
    id: u32,
    emit: EventSink,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    workspace: WorkspaceEnv,
    on_data: DataSink,
    on_exit: ExitSink,
) -> Result<(Arc<Session>, PtySize), String> {
    #[cfg(windows)]
    let _spawn_guard = CONPTY_LIFECYCLE_LOCK.lock().unwrap();

    let pty_system = native_pty_system();
    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = pty_system.openpty(size).map_err(|e| e.to_string())?;

    let (cmd, shell_label) = shell_init::build_command(id, cwd, workspace)?;
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    // Kill the child if any of the pipe setup below fails so the spawned shell
    // can't outlive an aborted pty_open.
    let mut guard = ChildKillGuard::new(child.clone_killer());
    let killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(
        pair.master.take_writer().map_err(|e| e.to_string())?,
    ));
    guard.disarm();

    let shell_pid = child.process_id().unwrap_or(0);

    #[cfg(windows)]
    let job = match child.process_id() {
        Some(pid) => match super::job::PtyJob::create_for(pid) {
            Ok(j) => Some(j),
            Err(e) => {
                log::warn!("pty job-object setup failed for pid={pid}: {e}");
                None
            }
        },
        None => None,
    };

    let pending: Arc<(Mutex<Pending>, Condvar)> =
        Arc::new((Mutex::new(Pending::new()), Condvar::new()));
    let done = Arc::new(AtomicBool::new(false));

    let session = Arc::new(Session {
        #[cfg(windows)]
        _job: job,
        shell_pid,
        shell_label,
        killer: Mutex::new(killer),
        writer: writer.clone(),
        master: Mutex::new(pair.master),
        flow: pending.clone(),
    });

    let spawn_at = Instant::now();

    let pending_r = pending.clone();
    let done_r = done.clone();
    let writer_for_da = writer.clone();
    let emit_reader = emit;
    let reader_thread = thread::Builder::new()
        .name("arterm-pty-reader".into())
        .spawn(move || {
            let mut buf = [0u8; READ_BUF];
            let mut filtered: Vec<u8> = Vec::with_capacity(READ_BUF);
            let mut da_filter = DaFilter::new();
            let mut agent_detect = AgentDetector::new();
            let mut command_detect = CommandDetector::new();
            let mut dropped_bytes: u64 = 0;
            let mut logged_first = false;
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if !logged_first {
                            logged_first = true;
                            log::debug!(
                                "pty first byte after {}ms",
                                spawn_at.elapsed().as_millis()
                            );
                        }
                        agent_detect.process(&buf[..n], |t| {
                            emit_reader(AGENT_EVENT, to_event_payload(t.into_signal(id)));
                        });
                        command_detect.process(&buf[..n], |end| {
                            emit_reader(
                                COMMAND_EVENT,
                                to_event_payload(end.into_signal(id, shell_label)),
                            );
                        });
                        filtered.clear();
                        da_filter.process(&buf[..n], &mut filtered, |reply| {
                            if let Ok(mut w) = writer_for_da.lock() {
                                let _ = w.write_all(reply);
                            }
                        });
                        if filtered.is_empty() {
                            continue;
                        }
                        push_with_backpressure(&pending_r, &filtered, &done_r, &mut dropped_bytes);
                    }
                    Err(e) => {
                        log::debug!("pty reader ended: {e}");
                        break;
                    }
                }
            }
            agent_detect.finish(|t| {
                emit_reader(AGENT_EVENT, to_event_payload(t.into_signal(id)));
            });
            pending_r.1.notify_one();
            if dropped_bytes > 0 {
                log::warn!("pty backpressure: dropped {dropped_bytes} bytes (cap {MAX_PENDING})");
            }
        })
        .expect("spawn pty reader thread");

    let on_data_flush = on_data.clone();
    let pending_f = pending.clone();
    let done_f = done.clone();
    thread::Builder::new()
        .name("arterm-pty-flusher".into())
        .spawn(move || {
            let (lock, cv) = &*pending_f;
            loop {
                {
                    let mut g = lock.lock().unwrap();
                    // Park while there's nothing to send: an empty buffer, or a
                    // frontend-requested pause. Shutdown (done) always wins so a
                    // close can't wedge us — on shutdown we fall through to drain
                    // whatever remains, even if still marked paused.
                    while g.buf.is_empty() || g.paused {
                        if done_f.load(Ordering::Acquire) {
                            if g.buf.is_empty() {
                                return;
                            }
                            break;
                        }
                        let (next, _) = cv.wait_timeout(g, FLUSH_MAX_IDLE).unwrap();
                        g = next;
                    }
                }
                // Coalesce a short window so a burst flushes as one chunk.
                thread::sleep(FLUSH_COALESCE);
                // Drain in bounded chunks so a resume burst can't hand xterm one
                // enormous write; re-check the pause flag between chunks.
                loop {
                    let chunk = {
                        let mut g = lock.lock().unwrap();
                        if g.buf.is_empty() || (g.paused && !done_f.load(Ordering::Acquire)) {
                            break;
                        }
                        let take = g.buf.len().min(FLUSH_CHUNK);
                        g.buf.drain(..take).collect::<Vec<u8>>()
                    };
                    if !on_data_flush(chunk) {
                        log::debug!("pty flusher exiting, sink closed");
                        return;
                    }
                }
            }
        })
        .expect("spawn pty flusher thread");

    let on_data_exit = on_data;
    let pending_e = pending;
    let done_e = done;
    thread::Builder::new()
        .name("arterm-pty-waiter".into())
        .spawn(move || {
            let code = match child.wait() {
                Ok(status) => status.exit_code() as i32,
                Err(e) => {
                    log::warn!("pty child wait failed: {e}");
                    -1
                }
            };
            // Child is gone. Signal shutdown and lift any flow-control pause so a
            // reader parked on backpressure wakes, drains the remaining kernel
            // buffer to EOF and exits. Setting `done` first means the reader
            // appends that tail instead of tripping the discard safety-net, and
            // the flusher won't re-park on `paused`.
            done_e.store(true, Ordering::Release);
            {
                let (lock, cv) = &*pending_e;
                lock.lock().unwrap().paused = false;
                cv.notify_all();
            }
            // Wait for the reader to hit EOF before taking a final snapshot of
            // `pending`, so the last line of output never races the Exit event.
            #[cfg(windows)]
            {
                let deadline = Instant::now() + Duration::from_millis(50);
                while Instant::now() < deadline && !reader_thread.is_finished() {
                    thread::sleep(Duration::from_millis(5));
                }
            }
            #[cfg(not(windows))]
            if let Err(e) = reader_thread.join() {
                log::error!("pty reader thread panicked: {e:?}");
            }
            let (lock, cv) = &*pending_e;
            let tail = std::mem::take(&mut lock.lock().unwrap().buf);
            if !tail.is_empty() && !on_data_exit(tail) {
                log::debug!("pty final-data send failed (sink closed)");
            }
            cv.notify_all();
            on_exit(code);
        })
        .expect("spawn pty waiter thread");

    Ok((session, size))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use portable_pty::CommandBuilder;

    #[test]
    fn drop_kills_child_process() {
        let pty_system = native_pty_system();
        let size = PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = pty_system.openpty(size).expect("openpty");

        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        cmd.arg("sleep 30");
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);

        let killer = child.clone_killer();
        let writer: Arc<Mutex<Box<dyn Write + Send>>> =
            Arc::new(Mutex::new(pair.master.take_writer().expect("writer")));

        let session = Arc::new(Session {
            shell_pid: child.process_id().unwrap_or(0),
            killer: Mutex::new(killer),
            writer,
            master: Mutex::new(pair.master),
            shell_label: "sh",
            flow: Arc::new((Mutex::new(Pending::new()), Condvar::new())),
        });

        assert!(
            child.try_wait().unwrap().is_none(),
            "child must be alive before drop",
        );

        drop(session);

        let deadline = Instant::now() + Duration::from_secs(2);
        let mut exited = false;
        while Instant::now() < deadline {
            if child.try_wait().unwrap().is_some() {
                exited = true;
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        assert!(exited, "child still running 2s after Session drop");
    }

    #[test]
    fn drop_session_succeeds_after_child_already_exited() {
        let pty_system = native_pty_system();
        let size = PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = pty_system.openpty(size).expect("openpty");

        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        cmd.arg("exit 0");
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);
        let _ = child.wait();

        let killer = child.clone_killer();
        let writer: Arc<Mutex<Box<dyn Write + Send>>> =
            Arc::new(Mutex::new(pair.master.take_writer().expect("writer")));

        let session = Arc::new(Session {
            shell_pid: 0,
            killer: Mutex::new(killer),
            writer,
            master: Mutex::new(pair.master),
            shell_label: "sh",
            flow: Arc::new((Mutex::new(Pending::new()), Condvar::new())),
        });

        drop_session(session);
    }

    fn contains_notice(haystack: &[u8]) -> bool {
        haystack
            .windows(OVERFLOW_NOTICE.len())
            .any(|w| w == OVERFLOW_NOTICE)
    }

    // Mirrors `seq 1 N` streaming through push_with_backpressure while paused.
    // We exercise the Pending/pause/resume/overflow logic directly rather than
    // through session::spawn(): spawn() would fork a real shell, which a unit
    // test shouldn't do. A producer thread stands in for the reader; a drainer thread stands
    // in for the flusher. N is chosen so the byte stream (~7.8 MiB) exceeds
    // MAX_PENDING, so the producer must actually block on the pause.
    #[test]
    fn backpressure_blocks_when_paused_then_delivers_intact_on_resume() {
        let n: u64 = 1_000_000;
        let pending: Arc<(Mutex<Pending>, Condvar)> =
            Arc::new((Mutex::new(Pending::new()), Condvar::new()));
        let done = Arc::new(AtomicBool::new(false));
        pending.0.lock().unwrap().paused = true;

        let finished = Arc::new(AtomicBool::new(false));
        let dropped_total = Arc::new(Mutex::new(0u64));

        let pending_p = pending.clone();
        let done_p = done.clone();
        let finished_p = finished.clone();
        let dropped_p = dropped_total.clone();
        let producer = thread::spawn(move || {
            let mut dropped = 0u64;
            for i in 1..=n {
                let line = format!("{i}\n");
                push_with_backpressure(&pending_p, line.as_bytes(), &done_p, &mut dropped);
            }
            *dropped_p.lock().unwrap() = dropped;
            finished_p.store(true, Ordering::Release);
        });

        // Let the buffer fill and the producer block on the pause.
        thread::sleep(Duration::from_millis(400));
        {
            let g = pending.0.lock().unwrap();
            assert!(
                g.buf.len() <= MAX_PENDING + 16,
                "pending grew past cap while paused: {}",
                g.buf.len()
            );
            assert!(
                !contains_notice(&g.buf),
                "overflow notice injected while paused"
            );
        }
        assert!(
            !finished.load(Ordering::Acquire),
            "producer should still be blocked on the pause"
        );

        // Resume and drain like the flusher would.
        let sink = Arc::new(Mutex::new(Vec::<u8>::new()));
        let pending_d = pending.clone();
        let sink_d = sink.clone();
        let finished_d = finished.clone();
        let drainer = thread::spawn(move || {
            let (lock, cv) = &*pending_d;
            loop {
                let chunk = {
                    let mut g = lock.lock().unwrap();
                    while g.buf.is_empty() {
                        if finished_d.load(Ordering::Acquire) {
                            return;
                        }
                        let (next, _) = cv.wait_timeout(g, Duration::from_millis(20)).unwrap();
                        g = next;
                    }
                    let take = g.buf.len().min(FLUSH_CHUNK);
                    g.buf.drain(..take).collect::<Vec<u8>>()
                };
                cv.notify_all();
                sink_d.lock().unwrap().extend_from_slice(&chunk);
            }
        });

        {
            let (lock, cv) = &*pending;
            lock.lock().unwrap().paused = false;
            cv.notify_all();
        }

        producer.join().unwrap();
        drainer.join().unwrap();

        assert_eq!(*dropped_total.lock().unwrap(), 0, "bytes were dropped");
        let out = sink.lock().unwrap();
        assert!(
            !contains_notice(&out),
            "overflow notice present in delivered stream"
        );
        let mut expected = Vec::new();
        for i in 1..=n {
            expected.extend_from_slice(format!("{i}\n").as_bytes());
        }
        assert_eq!(out.len(), expected.len(), "delivered byte count mismatch");
        assert_eq!(&out[..], &expected[..], "delivered stream corrupted or reordered");
    }
}
