//! Base-protocol framing shared by LSP and DAP.
//!
//! Both protocols frame messages as `Content-Length: <n>\r\n\r\n<n bytes of
//! UTF-8 JSON>`. This layer is the transport boundary: it owns the byte-level
//! framing so the frontend only ever sees whole JSON strings. Keep it free of
//! JSON-RPC / DAP semantics.

const SEPARATOR: &[u8] = b"\r\n\r\n";
const CONTENT_LENGTH: &str = "content-length";
// A single header block this large is a malformed/hostile server, not a real
// message; refuse it instead of buffering unboundedly while scanning for the
// separator.
const MAX_HEADER_BYTES: usize = 64 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum FrameError {
    MissingContentLength,
    InvalidContentLength,
    HeaderTooLarge,
}

/// Wraps a single JSON message in the base-protocol header.
pub fn encode(message: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(message.len() + 32);
    out.extend_from_slice(format!("Content-Length: {}\r\n\r\n", message.len()).as_bytes());
    out.extend_from_slice(message.as_bytes());
    out
}

/// Accumulates raw stdout bytes and yields complete JSON message bodies.
#[derive(Default)]
pub struct FrameParser {
    buf: Vec<u8>,
}

impl FrameParser {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, data: &[u8]) {
        self.buf.extend_from_slice(data);
    }

    /// Pull the next complete message. `None` means "need more bytes".
    /// `Some(Err(_))` is a framing violation; the offending header block is
    /// consumed so the caller can keep draining.
    pub fn next(&mut self) -> Option<Result<String, FrameError>> {
        let sep = match find(&self.buf, SEPARATOR) {
            Some(i) => i,
            None => {
                if self.buf.len() > MAX_HEADER_BYTES {
                    self.buf.clear();
                    return Some(Err(FrameError::HeaderTooLarge));
                }
                return None;
            }
        };

        let header_end = sep + SEPARATOR.len();
        let content_length = match parse_content_length(&self.buf[..sep]) {
            Ok(n) => n,
            Err(e) => {
                self.buf.drain(..header_end);
                return Some(Err(e));
            }
        };

        if self.buf.len() < header_end + content_length {
            return None;
        }

        let body: Vec<u8> = self
            .buf
            .drain(..header_end + content_length)
            .skip(header_end)
            .collect();
        // Lossy: a server emitting non-UTF-8 in a JSON body is already broken;
        // don't let one bad byte stall the whole stream.
        Some(Ok(String::from_utf8_lossy(&body).into_owned()))
    }
}

fn parse_content_length(headers: &[u8]) -> Result<usize, FrameError> {
    for line in headers.split(|&b| b == b'\n') {
        let line = trim_ascii(line);
        let Some(colon) = line.iter().position(|&b| b == b':') else {
            continue;
        };
        let name = trim_ascii(&line[..colon]);
        if name.eq_ignore_ascii_case(CONTENT_LENGTH.as_bytes()) {
            let value = trim_ascii(&line[colon + 1..]);
            return std::str::from_utf8(value)
                .ok()
                .and_then(|s| s.parse::<usize>().ok())
                .ok_or(FrameError::InvalidContentLength);
        }
    }
    Err(FrameError::MissingContentLength)
}

fn trim_ascii(mut s: &[u8]) -> &[u8] {
    while let [first, rest @ ..] = s {
        if first.is_ascii_whitespace() {
            s = rest;
        } else {
            break;
        }
    }
    while let [rest @ .., last] = s {
        if last.is_ascii_whitespace() {
            s = rest;
        } else {
            break;
        }
    }
    s
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_all(parser: &mut FrameParser) -> Vec<Result<String, FrameError>> {
        let mut out = Vec::new();
        while let Some(item) = parser.next() {
            out.push(item);
        }
        out
    }

    #[test]
    fn encode_roundtrips_through_parser() {
        let msg = r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#;
        let mut p = FrameParser::new();
        p.push(&encode(msg));
        assert_eq!(parse_all(&mut p), vec![Ok(msg.to_string())]);
    }

    #[test]
    fn encode_uses_byte_length_not_char_length() {
        // "é" is 2 bytes in UTF-8 but 1 char.
        let msg = r#"{"s":"é"}"#;
        let encoded = encode(msg);
        let header = format!("Content-Length: {}\r\n\r\n", msg.len());
        assert!(encoded.starts_with(header.as_bytes()));
    }

    #[test]
    fn waits_for_full_body_across_partial_reads() {
        let msg = r#"{"a":1}"#;
        let framed = encode(msg);
        let (head, tail) = framed.split_at(framed.len() - 3);
        let mut p = FrameParser::new();
        p.push(head);
        assert!(p.next().is_none(), "must wait for the rest of the body");
        p.push(tail);
        assert_eq!(p.next(), Some(Ok(msg.to_string())));
    }

    #[test]
    fn waits_when_header_split_mid_stream() {
        let msg = r#"{"a":1}"#;
        let framed = encode(msg);
        let mut p = FrameParser::new();
        p.push(&framed[..8]); // "Content-" only
        assert!(p.next().is_none());
        p.push(&framed[8..]);
        assert_eq!(p.next(), Some(Ok(msg.to_string())));
    }

    #[test]
    fn yields_multiple_messages_from_one_buffer() {
        let a = r#"{"a":1}"#;
        let b = r#"{"b":2}"#;
        let mut blob = encode(a);
        blob.extend_from_slice(&encode(b));
        let mut p = FrameParser::new();
        p.push(&blob);
        assert_eq!(
            parse_all(&mut p),
            vec![Ok(a.to_string()), Ok(b.to_string())]
        );
    }

    #[test]
    fn tolerates_extra_headers_and_odd_casing() {
        let msg = r#"{"a":1}"#;
        let framed = format!(
            "content-LENGTH: {}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{}",
            msg.len(),
            msg
        );
        let mut p = FrameParser::new();
        p.push(framed.as_bytes());
        assert_eq!(p.next(), Some(Ok(msg.to_string())));
    }

    #[test]
    fn reports_missing_content_length_then_recovers() {
        let good = r#"{"ok":1}"#;
        let mut blob = b"X-Bogus: 1\r\n\r\n".to_vec();
        blob.extend_from_slice(&encode(good));
        let mut p = FrameParser::new();
        p.push(&blob);
        let results = parse_all(&mut p);
        assert_eq!(
            results,
            vec![Err(FrameError::MissingContentLength), Ok(good.to_string())]
        );
    }

    #[test]
    fn reports_invalid_content_length() {
        let mut p = FrameParser::new();
        p.push(b"Content-Length: notanumber\r\n\r\n");
        assert_eq!(p.next(), Some(Err(FrameError::InvalidContentLength)));
    }

    #[test]
    fn body_split_does_not_corrupt_following_message() {
        let a = r#"{"a":1}"#;
        let b = r#"{"bb":22}"#;
        let mut blob = encode(a);
        blob.extend_from_slice(&encode(b));
        let mut p = FrameParser::new();
        // Feed one byte at a time: the worst-case streaming pattern.
        for chunk in blob.chunks(1) {
            p.push(chunk);
        }
        assert_eq!(
            parse_all(&mut p),
            vec![Ok(a.to_string()), Ok(b.to_string())]
        );
    }
}
