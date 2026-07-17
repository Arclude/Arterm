//! Protocol primitives shared by the LSP and DAP transports.
//!
//! Both speak JSON over stdio with identical `Content-Length` base-protocol
//! framing; that byte-level layer lives in `framing` so neither transport
//! re-implements it.

pub mod framing;

/// Shell-agnostic sink for framed protocol messages flowing to the frontend.
/// Returns `false` once the receiver is gone so reader threads can stop.
/// The Tauri shell wraps an `ipc::Channel<String>`; the Electron bridge wraps
/// a WebSocket `chan` message.
pub type MessageSink = Box<dyn Fn(String) -> bool + Send>;
