// Headless backend for the Electron shell on Linux. Runs the same module
// logic as the Tauri app but never initializes GTK/WebKit — the frontend
// lives in Electron and talks to this process over the WebSocket bridge.

/// Minimal stderr logger so `log::warn!` calls inside the shared modules
/// (e.g. PTY backpressure drops) stay visible without pulling in a logging
/// dependency. Warn+ by default; RUST_LOG=debug widens it.
struct StderrLogger {
    max: log::LevelFilter,
}

impl log::Log for StderrLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= self.max
    }

    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata()) {
            eprintln!(
                "[{}] {}: {}",
                record.level(),
                record.target(),
                record.args()
            );
        }
    }

    fn flush(&self) {}
}

fn init_logger() {
    let max = match std::env::var("RUST_LOG").as_deref() {
        Ok("trace") => log::LevelFilter::Trace,
        Ok("debug") => log::LevelFilter::Debug,
        Ok("info") => log::LevelFilter::Info,
        _ => log::LevelFilter::Warn,
    };
    let logger = Box::leak(Box::new(StderrLogger { max }));
    if log::set_logger(logger).is_ok() {
        log::set_max_level(max);
    }
}

fn main() {
    init_logger();
    let launch_dir = std::env::args()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .find_map(|a| {
            let canon = std::fs::canonicalize(&a).ok()?;
            canon.is_dir().then(|| canon.to_string_lossy().into_owned())
        });
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("bridge: tokio runtime");
    rt.block_on(arterm_lib::bridge::run(launch_dir));
}
