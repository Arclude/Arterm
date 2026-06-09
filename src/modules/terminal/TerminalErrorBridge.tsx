import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import {
  openTerminalErrorChat,
  type TerminalErrorContext,
} from "@/modules/ai/lib/terminalError";
import type { Tab } from "@/modules/tabs";
import { hasLeaf } from "./lib/panes";
import { leafIdForPty, readLeafBuffer } from "./lib/useTerminalSession";

type CommandErrorSignal = {
  id: number; // pty session id, resolve leaf via leafIdForPty(id)
  exitCode: number;
  command: string | null;
  cwd: string | null;
  shell: string;
};

type Activate = (tabId: number, leafId: number) => void;
type Ctx = {
  tabs: Tab[];
  activeId: number;
  onActivate: Activate;
};

function tabInfo(
  tabs: Tab[],
  leafId: number,
): { tabId: number; title: string; isPrivate: boolean } | null {
  for (const t of tabs) {
    if (t.kind === "terminal" && hasLeaf(t.paneTree, leafId)) {
      return { tabId: t.id, title: t.title, isPrivate: t.private === true };
    }
  }
  return null;
}

// Windows STATUS_CONTROL_C_EXIT (0xC000013A): Ctrl-C/Ctrl-Break of a native
// process. pwsh/cmd surface it in $LASTEXITCODE as a signed i32; the Rust
// side normalizes a raw unsigned form (3221225786) to this signed value
// before emitting (command_detect.rs parse_exit_code), so one check suffices.
const STATUS_CONTROL_C_EXIT = -1073741510;

function isUserCancellation(exitCode: number): boolean {
  return (
    exitCode === 130 || // POSIX 128 + SIGINT
    exitCode === STATUS_CONTROL_C_EXIT
  );
}

// Shells whose integration scripts never emit OSC 133;C;CMDLINE: pwsh and
// powershell emit only A/B/D, cmd has no integration script, and bash emits
// a bare C with no command text. A non-null command from these shells can
// only come from an escape sequence forged inside command OUTPUT (the Rust
// detector locks the command slot after the first C, but pwsh sessions never
// have a legitimate first C to lock on) — drop the signal rather than show
// attacker-controlled text in the toast or prefill it into the AI chat.
const NO_CMDLINE_SHELLS = new Set(["pwsh", "powershell", "cmd", "bash"]);

function isForged(sig: CommandErrorSignal): boolean {
  return sig.command !== null && NO_CMDLINE_SHELLS.has(sig.shell);
}

// Stale-replay suppression. The scripts are contract-frozen, and OSC 133;B
// (which arms the Rust detector) is embedded in the prompt itself, so it
// re-arms on every prompt render — D can then replay a stale code for a
// command that never ran:
// - pwsh/powershell: cmdlet-only commands never update $LASTEXITCODE and
//   profile.ps1 re-persists it, so after one failed native command EVERY
//   later cmdlet-only prompt (cd, Get-ChildItem, empty Enter, ...) re-emits
//   D;<stale code> with no command text.
// - bash/zsh/fish: an empty Enter preserves $?/$status and re-runs precmd,
//   replaying D;<stale nonzero> without a preexec (null command).
// Suppression rule: within DEDUPE_WINDOW_MS of the last signal, a
// null-command signal repeating the last exit code is treated as a replay
// and — crucially — REFRESHES the timestamp. pwsh replays on every prompt
// indefinitely, so a hard-bounded window would re-toast a phantom failure
// every 15s for the lifetime of the session; the sliding window keeps a
// continuous replay stream silent and naturally expires after 15s without
// signals. Trade-off (inherent: a stale replay is byte-identical to a new
// null-command failure with the same code): a genuine new failure sharing
// the previous exit code is suppressed while the stream is alive, but any
// failure with a different exit code, or after 15s of quiet, still toasts.
// An identical non-null-command repeat (zsh/fish re-running the same failing
// command) is suppressed WITHOUT refresh, so retries re-toast after at most
// the window. A null-command signal with a NEW exit code is never suppressed
// — this keeps zsh/fish failures that fire no preexec (syntax errors,
// invalid-UTF-8 cmdlines) toasting instead of being dropped outright.
const DEDUPE_WINDOW_MS = 15_000;
type DedupeEntry = { exitCode: number; command: string | null; at: number };
const lastSignalByLeaf = new Map<number, DedupeEntry>();

// Expired entries are dead weight (suppression is time-bounded), and the
// sweep also keeps closed leaves from leaking entries and respawned shells
// (same leafId) from inheriting the previous instance's suppression beyond
// the window.
function sweepExpired(now: number): void {
  for (const [leafId, entry] of lastSignalByLeaf) {
    if (now - entry.at >= DEDUPE_WINDOW_MS) lastSignalByLeaf.delete(leafId);
  }
}

function shouldSuppress(sig: CommandErrorSignal, leafId: number): boolean {
  const now = Date.now();
  sweepExpired(now);
  const prev = lastSignalByLeaf.get(leafId);
  if (prev && now - prev.at < DEDUPE_WINDOW_MS) {
    if (sig.command === null && sig.exitCode === prev.exitCode) {
      // Stale precmd replay: refresh so a continuous stream (pwsh re-emits
      // on every prompt render) stays suppressed instead of re-toasting a
      // phantom failure every window.
      prev.at = now;
      return true;
    }
    if (
      sig.command !== null &&
      sig.command === prev.command &&
      sig.exitCode === prev.exitCode
    ) {
      return true; // exact repeat: no refresh, suppression stays hard-bounded
    }
  }
  lastSignalByLeaf.set(leafId, {
    exitCode: sig.exitCode,
    command: sig.command,
    at: now,
  });
  return false;
}

function handleSignal(sig: CommandErrorSignal, getCtx: () => Ctx): void {
  if (isForged(sig)) return; // output-embedded OSC forgery, never legitimate
  if (isUserCancellation(sig.exitCode)) return; // user cancel, not an error
  const leafId = leafIdForPty(sig.id);
  if (leafId === null) return;
  const info = tabInfo(getCtx().tabs, leafId);
  if (!info || info.isPrivate) return;
  if (shouldSuppress(sig, leafId)) return;

  // Snapshot the tail at signal time — the short delay lets xterm finish
  // parsing the chunk that carried the D marker. Reading at click time would
  // race the dormant-ring drain after onActivate and let later commands push
  // the error out of the 80-line tail. readLeafBuffer's dormant fallback
  // includes the ring, so no rebind is needed before reading.
  let output: string | null = null;
  const capture = () => {
    output = readLeafBuffer(leafId, 80) ?? "";
  };
  setTimeout(capture, 100);

  const launch = (mode: "explain" | "fix") => {
    const ctx = getCtx();
    // Re-check privacy with fresh tabs — the toast lives 15s and the tab
    // may have been toggled private (or closed) since the signal.
    const now = tabInfo(ctx.tabs, leafId);
    if (!now || now.isPrivate) return;
    // Capture BEFORE activating: onActivate can rebind a dormant leaf and
    // start draining its ring into xterm asynchronously, so a slot-path read
    // right after activation would see a mid-replay buffer. readLeafBuffer's
    // dormant fallback already includes the ring, so reading first is safe.
    if (output === null) capture();
    if (ctx.activeId !== now.tabId) ctx.onActivate(now.tabId, leafId);
    const errCtx: TerminalErrorContext = {
      command: sig.command,
      exitCode: sig.exitCode,
      cwd: sig.cwd,
      shell: sig.shell,
      output: output ?? "",
    };
    openTerminalErrorChat(mode, errCtx);
  };

  // Fixed id per leaf: concurrent signals refresh the toast instead of
  // stacking (stale replays are dropped above).
  toast(`Command failed (exit ${sig.exitCode})`, {
    id: `term-error-${leafId}`,
    description: sig.command ?? info.title,
    duration: 15000,
    action: { label: "Explain", onClick: () => launch("explain") },
    cancel: { label: "Fix", onClick: () => launch("fix") },
  });
}

export function TerminalErrorBridge({
  tabs,
  activeId,
  onActivate,
}: {
  tabs: Tab[];
  activeId: number;
  onActivate: Activate;
}) {
  const ctxRef = useRef<Ctx>({ tabs, activeId, onActivate });
  ctxRef.current = { tabs, activeId, onActivate };

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    listen<CommandErrorSignal>("artex:command-error", (e) =>
      handleSignal(e.payload, () => ctxRef.current),
    )
      .then((u) => {
        if (alive) unlisten = u;
        else u();
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  return null;
}
