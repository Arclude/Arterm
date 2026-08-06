import { Undo02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { getCliClient } from "../clientRegistry";
import {
  REWIND_COLOR_VAR,
  REWIND_GLYPH,
  type RewindOutcome,
  rewindOutcome,
} from "../lib/checkpoints";
import { fmtElapsed } from "../lib/dashboard";
import type { CliCheckpoint } from "../types";

const btn =
  "cli-mono inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-2 py-0.5 text-[10.5px] text-muted-foreground outline-none transition-colors hover:border-[color:var(--cli-accent)] hover:text-[color:var(--cli-accent)] focus-visible:ring-2 focus-visible:ring-[color:var(--cli-accent)]/40 disabled:opacity-50";

/**
 * The session's undoable turns, each restorable through the `rewind` control
 * action. Rewinding from here is the whole point: the checkpoint store belongs
 * to a CLI session that may be running in a background tab, or under
 * `--autonomous` with nobody watching the terminal at all.
 *
 * LAYOUT: like {@link PermissionRequest}, this is a FIXED-height bar whose body
 * is an overlay, never an in-flow block. The session pane is a flex column whose
 * only elastic child is the topology graph, so an in-flow list of up to ten rows
 * would collapse the graph by its own height every time it opened — under the
 * pointer, at the moment the user is reaching for a destructive button. Keep
 * every change here layout-neutral.
 */
export function CheckpointList({
  sessionId,
  checkpoints,
  now,
  agentBusy,
}: {
  sessionId: string;
  /** `snapshot.checkpoints`, newest first. Never empty — the caller gates on it. */
  checkpoints: CliCheckpoint[];
  /** Ticking clock from the dashboard, so the ages age. */
  now: number;
  /** The agent is mid-turn: it will keep writing over whatever we restore. */
  agentBusy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Restoring files under a running agent is destructive, so it takes two
  // clicks — like Stop and like a destructive permission prompt.
  const [pendingConfirm, setPendingConfirm] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<RewindOutcome | null>(null);

  // Derived rather than stored, so a confirm can never outlive its checkpoint:
  // a new turn pushes a new entry and the list shifts under the buttons. The
  // confirm is bound to the ID, not the row — the entry the user armed is the
  // one that gets restored even after it has moved down the list.
  const confirming =
    pendingConfirm !== null &&
    checkpoints.some((c) => c.id === pendingConfirm) &&
    !busy
      ? pendingConfirm
      : null;

  const rewind = async (id: string) => {
    const client = getCliClient(sessionId);
    if (!client) {
      setOutcome({ kind: "failed", text: "Session is not connected" });
      return;
    }
    setBusy(true);
    try {
      // Reported inline rather than as a toast: `detail` names the files the
      // restore could NOT put back, and that has to stay on screen next to the
      // list it contradicts — a toast that has faded is a partial restore the
      // user now believes was a full one.
      setOutcome(
        rewindOutcome(
          await client.control("rewind", {
            checkpointId: id,
          }),
        ),
      );
    } finally {
      setBusy(false);
      setPendingConfirm(null);
    }
  };

  return (
    // `z-20` lifts bar and overlay above the topology graph the overlay hangs
    // over, while staying under the permission prompt's `z-30`: a blocked agent
    // outranks an undo.
    <div
      className="relative z-20 shrink-0 border-b border-border/50"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 w-full items-center gap-2 px-4 text-left outline-none transition-colors hover:bg-card/50 focus-visible:bg-card/50"
      >
        <HugeiconsIcon
          icon={Undo02Icon}
          size={12}
          strokeWidth={2}
          className="shrink-0 text-muted-foreground"
        />
        <span className="cli-mono shrink-0 text-[11px] text-muted-foreground">
          Rewind
        </span>
        <span className="cli-mono shrink-0 text-[10.5px] text-muted-foreground/60">
          {checkpoints.length} undoable turn
          {checkpoints.length === 1 ? "" : "s"}
        </span>
        {/* The last restore's verdict survives collapsing the list. A partial
            restore is a standing condition of the working tree, not a
            notification — it must not vanish because the panel was closed. */}
        {outcome ? (
          <span
            className="cli-mono min-w-0 flex-1 truncate text-[10.5px]"
            style={{ color: REWIND_COLOR_VAR[outcome.kind] }}
            title={outcome.text}
          >
            {REWIND_GLYPH[outcome.kind]} {outcome.text}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <span
          aria-hidden="true"
          className="cli-mono shrink-0 text-[10.5px] text-muted-foreground/60"
        >
          {open ? "▾" : "▸"}
        </span>
      </button>

      {open ? (
        <div className="absolute inset-x-0 top-full max-h-[min(52vh,360px)] overflow-auto border-b border-border/60 bg-card px-4 py-2 shadow-lg">
          <p className="cli-mono pb-1.5 text-[10px] leading-snug text-muted-foreground/70">
            Restores the files a turn changed, newest first. Nothing else is
            undone — the conversation, and anything already committed, stay as
            they are.
          </p>
          {/* The agent does not pause for this. Restoring under a live turn is
              a race the agent wins, and the result reads as a rewind that
              silently did nothing. */}
          {agentBusy ? (
            <p
              className="cli-mono pb-1.5 text-[10px] leading-snug"
              style={{ color: "var(--cli-await)" }}
            >
              ⚠ the agent is working — it can overwrite restored files as soon
              as they land.
            </p>
          ) : null}
          <ul className="flex flex-col gap-1">
            {checkpoints.map((c) => (
              <li
                key={c.id}
                className="flex items-center gap-2 rounded-lg border border-border/50 bg-background/40 px-2.5 py-1.5"
              >
                <span
                  className="cli-mono min-w-0 flex-1 truncate text-[11px] text-foreground/85"
                  title={c.label}
                >
                  {c.label}
                </span>
                <span className="cli-mono shrink-0 text-[10px] text-muted-foreground/60">
                  {fmtElapsed(Math.max(0, Math.floor((now - c.at) / 1000)))} ago
                </span>
                {confirming === c.id ? (
                  <>
                    <button
                      type="button"
                      className={cn(
                        btn,
                        "border-[color:var(--cli-fail)] text-[color:var(--cli-fail)] hover:border-[color:var(--cli-fail)] hover:text-[color:var(--cli-fail)]",
                      )}
                      disabled={busy}
                      onClick={() => void rewind(c.id)}
                    >
                      Confirm rewind
                    </button>
                    <button
                      type="button"
                      className={btn}
                      disabled={busy}
                      onClick={() => setPendingConfirm(null)}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className={cn(
                      btn,
                      "hover:border-[color:var(--cli-fail)] hover:text-[color:var(--cli-fail)]",
                    )}
                    disabled={busy}
                    title={`Restore the files this turn changed (${new Date(c.at).toLocaleString()})`}
                    onClick={() => setPendingConfirm(c.id)}
                  >
                    Rewind…
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
