//! Protocol primitives shared by the LSP and DAP transports.
//!
//! Both speak JSON over stdio with identical `Content-Length` base-protocol
//! framing; that byte-level layer lives in `framing` so neither transport
//! re-implements it.

pub mod framing;
