//! Discovery of running Arterm-CLI status servers.
//!
//! Each Arterm-CLI process with its status server enabled writes a discovery
//! file at `~/.arterm/status/<pid>.json` (see docs/arterm-cli-integration.md).
//! This module enumerates those files for the frontend "CLI Agents" tab. It does
//! NOT health-check or verify liveness — the frontend hits each `/api/health`
//! before trusting a session, which is also the point at which a stale
//! discovery file (process gone but file not swept yet) is dropped.

use std::fs;
use std::path::PathBuf;

/// One discovered Arterm-CLI status server, mirrored from its discovery file.
///
/// Naming is camelCase on the wire in BOTH directions: the discovery file on
/// disk uses camelCase keys (`sessionId`, `startedAt`, `terminalId`), and the
/// frontend contract expects the same, so `rename_all = "camelCase"` covers the
/// deserialize (file → struct) and serialize (struct → frontend) paths alike.
/// Unknown fields are ignored by default, honoring the contract's "consumers
/// MUST ignore unknown fields" rule.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliSessionInfo {
    pub v: u32,
    pub pid: u32,
    pub session_id: String,
    pub port: u16,
    pub token: String,
    pub cwd: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    pub started_at: i64,
    #[serde(default)]
    pub terminal_id: Option<u32>,
}

fn status_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".arterm").join("status"))
}

/// Parse one discovery file's contents. `None` on any parse failure (malformed
/// JSON, missing required fields) so a single bad file never sinks the scan.
///
/// The `v` field is preserved rather than filtered here: the frontend keys on it
/// to surface an "unsupported protocol" state for `v != 1` sessions (contract §5),
/// so the entry must survive this far.
fn parse_entry(contents: &str) -> Option<CliSessionInfo> {
    serde_json::from_str::<CliSessionInfo>(contents).ok()
}

/// Enumerate every discoverable Arterm-CLI status server.
///
/// Reads `~/.arterm/status/*.json`, parsing each file independently; malformed
/// or unreadable files are silently skipped. A missing directory (no CLI has
/// ever run) is the common case and yields an empty list, not an error.
#[tauri::command]
pub fn arterm_cli_list_sessions() -> Vec<CliSessionInfo> {
    let Some(dir) = status_dir() else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(contents) = fs::read_to_string(&path) else {
            continue;
        };
        match parse_entry(&contents) {
            Some(info) => out.push(info),
            None => log::debug!(
                "arterm_cli: skipping unparsable discovery file {}",
                path.display()
            ),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
        "v": 1,
        "pid": 31264,
        "sessionId": "3f6d2a1e-9c4b-4c6e-b1a2-0e8f7d6c5b4a",
        "port": 53817,
        "token": "9f2c8a7b6e5d4c3b2a190817263544f5",
        "cwd": "C:\\Users\\me\\proj",
        "model": "qwen2.5-coder:7b",
        "provider": "ollama",
        "startedAt": 1783853172981,
        "terminalId": 3
    }"#;

    #[test]
    fn parses_camelcase_discovery_file() {
        let info = parse_entry(SAMPLE).expect("valid sample parses");
        assert_eq!(info.v, 1);
        assert_eq!(info.pid, 31264);
        assert_eq!(info.session_id, "3f6d2a1e-9c4b-4c6e-b1a2-0e8f7d6c5b4a");
        assert_eq!(info.port, 53817);
        assert_eq!(info.started_at, 1783853172981);
        assert_eq!(info.terminal_id, Some(3));
        assert_eq!(info.model.as_deref(), Some("qwen2.5-coder:7b"));
    }

    #[test]
    fn missing_optional_fields_default_to_none() {
        let json = r#"{
            "v": 1,
            "pid": 42,
            "sessionId": "s",
            "port": 1234,
            "token": "t",
            "cwd": "/tmp",
            "startedAt": 1
        }"#;
        let info = parse_entry(json).expect("required-only sample parses");
        assert_eq!(info.terminal_id, None);
        assert_eq!(info.model, None);
        assert_eq!(info.provider, None);
    }

    #[test]
    fn ignores_unknown_fields() {
        let json = r#"{
            "v": 1, "pid": 1, "sessionId": "s", "port": 1, "token": "t",
            "cwd": "/", "startedAt": 1, "futureField": "ignored"
        }"#;
        assert!(parse_entry(json).is_some());
    }

    #[test]
    fn non_v1_still_parses_so_frontend_can_flag_it() {
        let json = r#"{
            "v": 2, "pid": 1, "sessionId": "s", "port": 1, "token": "t",
            "cwd": "/", "startedAt": 1
        }"#;
        let info = parse_entry(json).expect("v2 with v1 shape still parses");
        assert_eq!(info.v, 2);
    }

    #[test]
    fn rejects_malformed_and_incomplete() {
        assert!(parse_entry("{ not json,").is_none());
        // Missing required `token`.
        assert!(
            parse_entry(r#"{"v":1,"pid":1,"sessionId":"s","port":1,"cwd":"/","startedAt":1}"#)
                .is_none()
        );
    }

    #[test]
    fn round_trips_to_camelcase_for_the_frontend() {
        let info = parse_entry(SAMPLE).unwrap();
        let out = serde_json::to_value(&info).unwrap();
        assert_eq!(out["sessionId"], "3f6d2a1e-9c4b-4c6e-b1a2-0e8f7d6c5b4a");
        assert_eq!(out["startedAt"], 1783853172981_i64);
        assert_eq!(out["terminalId"], 3);
        assert!(out.get("session_id").is_none(), "must not leak snake_case");
    }
}
