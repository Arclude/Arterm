import type { IMarker, Terminal } from "@xterm/xterm";

/**
 * Cross-handler state shared between the OSC 7 cwd handler and the OSC 133
 * prompt-marker handler. Tracks whether we are currently inside a running
 * command (between OSC 133 B and the next OSC 133 D / A), so the cwd handler
 * can ignore OSC 7 updates emitted by *command output* (e.g. a remote SSH
 * server, a `cat` of an attacker-controlled file). Only OSC 7 issued by the
 * local shell — which fires between commands — should be honored.
 */
export type ShellIntegrationState = {
  inCommand: boolean;
};

export function createShellIntegrationState(): ShellIntegrationState {
  return { inCommand: false };
}

export function registerCwdHandler(
  term: Terminal,
  onCwd: (cwd: string) => void,
  state?: ShellIntegrationState,
): () => void {
  const d = term.parser.registerOscHandler(7, (data) => {
    // Reject OSC 7 emitted while a command is running: command stdout/stderr
    // is untrusted (it can come from a remote shell, an SSH session, a `cat`
    // of attacker-controlled bytes). The local shell only emits OSC 7
    // between commands via its precmd/PROMPT_COMMAND hook.
    if (state?.inCommand) return true;
    const cwd = parseOsc7(data);
    if (cwd) onCwd(cwd);
    return true;
  });
  return () => d.dispose();
}

export type PromptTracker = {
  getMarker: () => IMarker | null;
  dispose: () => void;
};

export function registerPromptTracker(
  term: Terminal,
  state?: ShellIntegrationState,
): PromptTracker {
  let marker: IMarker | null = null;
  const d = term.parser.registerOscHandler(133, (data) => {
    // OSC 133 A — start of new prompt (between commands).
    if (data.startsWith("A")) {
      if (state) state.inCommand = false;
      marker?.dispose();
      marker = term.registerMarker(0);
    } else if (data.startsWith("B")) {
      // OSC 133 B — command begins. From here on, treat all output as
      // untrusted until we see D (command exit) or the next A (new prompt).
      if (state) state.inCommand = true;
    } else if (data.startsWith("C")) {
      // OSC 133 C — command pre-execution marker; still inside command.
      if (state) state.inCommand = true;
    } else if (data.startsWith("D")) {
      // OSC 133 D — command ends.
      if (state) state.inCommand = false;
    }
    return true;
  });
  return {
    getMarker: () => (marker && !marker.isDisposed ? marker : null),
    dispose: () => {
      d.dispose();
      marker?.dispose();
      marker = null;
    },
  };
}

function parseOsc7(data: string): string | null {
  const m = data.match(/^file:\/\/[^/]*(\/.*)$/);
  if (!m) return null;
  let path = m[1];
  try {
    path = decodeURIComponent(path);
  } catch {}
  // /C:/Users/foo -> C:/Users/foo so it's a valid Windows path.
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
  return path;
}

/**
 * Max accepted OSC 52 base64 payload (~300 KB decoded). Large enough for any
 * legitimate copy (Arterm CLI caps its own /copy payload at 100k chars),
 * small enough that hostile output can't balloon the clipboard endlessly.
 */
const OSC52_MAX_B64 = 400_000;

/**
 * OSC 52 — programs putting text on the system clipboard. This is how a
 * terminal app copies without owning a display: Arterm CLI's `/copy`, tmux's
 * `set-clipboard`, vim's `"+y` over SSH. Without a handler xterm.js silently
 * drops the sequence, which read as "copy is broken" inside the desktop app.
 *
 * WRITE-only, on purpose. A payload of `?` asks the terminal to REPLY with the
 * clipboard's current contents, and that is never answered: terminal output is
 * untrusted (a remote SSH host, a `cat` of a hostile file), and answering
 * would hand it whatever the user last copied — passwords included. kitty and
 * foot default to the same asymmetry for the same reason.
 */
export function registerOsc52Clipboard(
  term: Terminal,
  writeClipboard: (text: string) => void = (text) => {
    void navigator.clipboard.writeText(text).catch(() => {});
  },
): () => void {
  const d = term.parser.registerOscHandler(52, (data) => {
    // "Pc;Pd" — Pc names a clipboard buffer (c/p/s…; all land on the one
    // system clipboard a browser exposes), Pd is the base64 payload.
    const sep = data.indexOf(";");
    if (sep === -1) return true;
    const payload = data.slice(sep + 1);
    if (
      payload === "?" ||
      payload.length === 0 ||
      payload.length > OSC52_MAX_B64
    )
      return true;
    try {
      const bytes = Uint8Array.from(atob(payload), (ch) => ch.charCodeAt(0));
      const text = new TextDecoder().decode(bytes);
      if (text) writeClipboard(text);
    } catch {
      // Not valid base64 — malformed or hostile; drop, never guess.
    }
    return true;
  });
  return () => d.dispose();
}
