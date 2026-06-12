import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { generateShellCommand } from "@/modules/ai/lib/terminalNlCommand";
import { Cancel01Icon, TerminalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";
import {
  getSessionInfo,
  readLeafBuffer,
  writeToSession,
} from "./lib/useTerminalSession";

// Ctrl+K natural-language → command affordance. The generated command is
// INSERTED into the shell prompt for review — never executed by us.

type AiCommandState = {
  /** Leaf the overlay is open for; null = closed. */
  leafId: number | null;
  /** Private terminals never leak buffer contents into the AI request. */
  isPrivate: boolean;
  open: (leafId: number, isPrivate: boolean) => void;
  close: () => void;
};

export const useAiCommandStore = create<AiCommandState>((set) => ({
  leafId: null,
  isPrivate: false,
  open: (leafId, isPrivate) => set({ leafId, isPrivate }),
  close: () => set({ leafId: null }),
}));

const BUFFER_TAIL_LINES = 15;

/** Bracketed paste so multiline commands land in the prompt without running. */
function toPromptInsert(cmd: string): string {
  const t = cmd.replace(/\r?\n$/, "");
  return t.includes("\n") ? `\x1b[200~${t}\x1b[201~` : t;
}

type Phase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "done"; command: string; forQuery: string }
  | { kind: "error"; message: string };

export function TerminalAiCommand({
  leafId,
  onDone,
}: {
  leafId: number;
  /** Called after close so the host pane can refocus the terminal. */
  onDone: () => void;
}) {
  const openLeafId = useAiCommandStore((s) => s.leafId);
  const isPrivate = useAiCommandStore((s) => s.isPrivate);
  const isOpen = openLeafId === leafId;

  const [query, setQuery] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Horizontal centering is on the viewport (so the sidebar doesn't push the
  // overlay off-center), but the vertical anchor stays on the host pane so a
  // bottom split's overlay doesn't jump to the top of the screen. Measure the
  // pane's viewport top and pin the fixed overlay there.
  const [topPx, setTopPx] = useState(0);

  useEffect(() => {
    if (!isOpen) return;
    setQuery("");
    setPhase({ kind: "idle" });
    // The opening Ctrl+K keydown is still being processed; focus next tick.
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      clearTimeout(t);
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [isOpen]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    const measure = () => {
      const pane = rootRef.current?.parentElement;
      if (pane) setTopPx(pane.getBoundingClientRect().top + 8);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [isOpen]);

  if (!isOpen) return null;

  const close = () => {
    abortRef.current?.abort();
    useAiCommandStore.getState().close();
    onDone();
  };

  const insert = (command: string) => {
    writeToSession(leafId, toPromptInsert(command));
    close();
  };

  const generate = () => {
    const q = query.trim();
    if (!q) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPhase({ kind: "loading" });
    const info = getSessionInfo(leafId);
    const recentOutput = isPrivate
      ? null
      : readLeafBuffer(leafId, BUFFER_TAIL_LINES);
    generateShellCommand(
      q,
      {
        shell: info?.shell ?? null,
        cwd: info?.cwd ?? null,
        recentOutput,
      },
      ctrl.signal,
    )
      .then((command) => {
        if (ctrl.signal.aborted) return;
        setPhase({ kind: "done", command, forQuery: q });
      })
      .catch((e) => {
        if (ctrl.signal.aborted) return;
        setPhase({ kind: "error", message: e?.message ?? String(e) });
      });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== "Enter") return;
    e.preventDefault();
    // Enter inserts the shown command when the query hasn't changed since it
    // was generated; otherwise it (re)generates for the edited query.
    if (phase.kind === "done" && phase.forQuery === query.trim()) {
      insert(phase.command);
    } else {
      generate();
    }
  };

  return (
    <div
      ref={rootRef}
      data-terminal-ai-command
      className="fixed left-1/2 z-20 w-[min(560px,92%)] -translate-x-1/2"
      style={{ top: topPx }}
    >
      <div className="rounded-2xl border border-border bg-popover/95 p-2 shadow-lg backdrop-blur">
        <div className="flex items-center gap-2">
          <HugeiconsIcon
            icon={TerminalIcon}
            size={14}
            className="shrink-0 text-muted-foreground"
          />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Describe a command… (Enter to generate, Esc to close)"
            className="h-7 rounded-xl bg-transparent px-2 text-xs"
            spellCheck={false}
          />
          {phase.kind === "loading" ? (
            <Spinner className="size-3.5 shrink-0" />
          ) : (
            <button
              type="button"
              onClick={close}
              className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
              aria-label="Close"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
            </button>
          )}
        </div>
        {phase.kind === "done" && (
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-muted/60 px-2 py-1 font-mono text-xs text-foreground">
              {phase.command}
            </code>
            <Button
              size="xs"
              variant="ghost"
              className="shrink-0"
              onClick={() => insert(phase.command)}
            >
              Insert ⏎
            </Button>
          </div>
        )}
        {phase.kind === "error" && (
          <div className="mt-2 px-1 text-xs text-destructive">
            {phase.message}
          </div>
        )}
      </div>
    </div>
  );
}
