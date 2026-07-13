import {
  PauseIcon,
  PlayIcon,
  Sent02Icon,
  StopIcon,
  Target01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { getCliClient } from "../clientRegistry";
import type { AutonomyMode, AutonomyState, ControlAction } from "../types";

const btn =
  "cli-mono inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-[11.5px] text-muted-foreground outline-none transition-colors hover:border-[color:var(--cli-accent)] hover:text-[color:var(--cli-accent)] focus-visible:ring-2 focus-visible:ring-[color:var(--cli-accent)]/40 disabled:opacity-50";

const MODES: AutonomyMode[] = ["once", "eternal", "parallel", "phased", "team"];

export function SessionControls({
  sessionId,
  autonomyState,
  mode,
}: {
  sessionId: string;
  autonomyState: AutonomyState;
  /** Current autonomy mode (from `snapshot.autonomy.mode`). */
  mode: string;
}) {
  const [pending, setPending] = useState<ControlAction | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [steer, setSteer] = useState("");
  const [goal, setGoal] = useState("");
  const busy = pending !== null;
  // Run controls (pause/resume/stop) and a mode change are only meaningful while
  // a run exists; the CLI treats them as no-ops otherwise (contract §2), which
  // would surface a confusing error toast. Gate them on the live run state.
  const hasRun = autonomyState === "running" || autonomyState === "paused";
  // Steer is a mid-run course-correction — it only does something while a run is
  // actively executing (contract: autonomy.steer). Dim it otherwise.
  const canSteer = autonomyState === "running";

  const run = useCallback(
    async (action: ControlAction, note?: string, modeArg?: string) => {
      const client = getCliClient(sessionId);
      if (!client) {
        toast.error("Session is not connected");
        return false;
      }
      setPending(action);
      try {
        const res = await client.control(action, note, modeArg);
        if (!res.ok) {
          toast.error(
            res.error ? `${action}: ${res.error}` : `${action} failed`,
          );
        }
        return res.ok;
      } finally {
        setPending(null);
      }
    },
    [sessionId],
  );

  const submitSteer = async () => {
    const text = steer.trim();
    if (!text) return;
    if (await run("steer", text)) setSteer("");
  };
  const submitGoal = async () => {
    const text = goal.trim();
    if (!text) return;
    if (await run("goal", text)) setGoal("");
  };
  const changeMode = (next: string) => {
    if (next === mode) return;
    void run("mode", undefined, next);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {/* Run controls appear only during an active run (contract §2 no-op guard). */}
        {autonomyState === "paused" ? (
          <button
            type="button"
            className={btn}
            disabled={busy}
            onClick={() => void run("resume")}
          >
            <HugeiconsIcon icon={PlayIcon} size={12} strokeWidth={2} />
            Resume
          </button>
        ) : autonomyState === "running" ? (
          <button
            type="button"
            className={btn}
            disabled={busy}
            onClick={() => void run("pause")}
          >
            <HugeiconsIcon icon={PauseIcon} size={12} strokeWidth={2} />
            Pause
          </button>
        ) : null}

        {!hasRun ? null : confirmStop ? (
          <>
            <button
              type="button"
              className={cn(
                btn,
                "border-[color:var(--cli-fail)] text-[color:var(--cli-fail)] hover:border-[color:var(--cli-fail)] hover:text-[color:var(--cli-fail)]",
              )}
              disabled={busy}
              onClick={async () => {
                await run("stop");
                setConfirmStop(false);
              }}
            >
              Confirm stop
            </button>
            <button
              type="button"
              className={btn}
              disabled={busy}
              onClick={() => setConfirmStop(false)}
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
            onClick={() => setConfirmStop(true)}
          >
            <HugeiconsIcon icon={StopIcon} size={12} strokeWidth={2} />
            Stop
          </button>
        )}

        <label
          title="Nudge a running session — a mid-run course-correction, no restart. Only active while a run is in progress."
          className={cn(
            "flex min-w-40 flex-1 items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5",
            !canSteer && "opacity-55",
          )}
        >
          <span
            className="cli-mono shrink-0 text-[11px]"
            style={{ color: "var(--cli-accent)" }}
          >
            steer ›
          </span>
          <input
            value={steer}
            onChange={(e) => setSteer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitSteer();
            }}
            disabled={busy || !canSteer}
            placeholder={
              canSteer
                ? "nudge the running agent… (⏎)"
                : "available during a run"
            }
            className="cli-mono min-w-0 flex-1 bg-transparent text-[11.5px] text-foreground outline-none placeholder:text-muted-foreground/70"
          />
          <button
            type="button"
            onClick={() => void submitSteer()}
            disabled={busy || !canSteer || steer.trim() === ""}
            title="Nudge the running session"
            className="shrink-0 text-muted-foreground transition-colors hover:text-[color:var(--cli-accent)] disabled:opacity-40"
          >
            <HugeiconsIcon icon={Sent02Icon} size={13} strokeWidth={2} />
          </button>
        </label>

        {/* Goal is the primary action — accent-framed so it reads as "start here". */}
        <label
          title="Start an autonomous run toward a goal — the agent decides→acts→repeats until done."
          className="flex min-w-40 flex-1 items-center gap-1.5 rounded-lg border border-[color:var(--cli-accent)]/55 bg-[color:var(--cli-accent)]/[0.07] px-3 py-1.5"
        >
          <span
            className="cli-mono shrink-0 text-[11px] font-semibold"
            style={{ color: "var(--cli-accent)" }}
          >
            goal ›
          </span>
          <input
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitGoal();
            }}
            disabled={busy}
            placeholder="start an autonomous run… (⏎)"
            className="cli-mono min-w-0 flex-1 bg-transparent text-[11.5px] text-foreground outline-none placeholder:text-muted-foreground/70"
          />
          <button
            type="button"
            onClick={() => void submitGoal()}
            disabled={busy || goal.trim() === ""}
            title="Start an autonomous run toward this goal"
            className="shrink-0 text-[color:var(--cli-accent)] transition-opacity hover:opacity-80 disabled:opacity-40"
          >
            <HugeiconsIcon icon={Target01Icon} size={13} strokeWidth={2} />
          </button>
        </label>

        <div
          title="How an autonomous run behaves: once (single pass), eternal (keep going), parallel (fan out), phased (staged plan), or team (multi-agent). Set before starting a run."
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5"
        >
          <span
            className="cli-mono text-[11px]"
            style={{ color: "var(--cli-accent)" }}
          >
            mode ›
          </span>
          {/* Themed Select (not native <select>) — native option popups render with
              near-zero contrast in the WebView2 window; this uses the app popover. */}
          <Select
            value={mode}
            onValueChange={changeMode}
            disabled={busy || hasRun}
          >
            <SelectTrigger
              size="sm"
              title={
                hasRun
                  ? "Mode can't change during a run"
                  : "How the autonomous run behaves"
              }
              className="cli-mono h-auto w-[92px] border-0 bg-transparent px-0 py-0 text-[11.5px] shadow-none focus-visible:ring-0"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="cli-mono">
              {/* A non-standard current value (older CLI) stays selectable. */}
              {(MODES as string[]).includes(mode) ? null : (
                <SelectItem value={mode} className="text-[12px]">
                  {mode}
                </SelectItem>
              )}
              {MODES.map((m) => (
                <SelectItem key={m} value={m} className="text-[12px]">
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Always-visible legend — these terms weren't self-explanatory. */}
      <p className="cli-mono px-0.5 text-[9.5px] leading-relaxed text-muted-foreground/60">
        <b className="font-semibold text-muted-foreground/90">goal</b> starts an
        autonomous run ·{" "}
        <b className="font-semibold text-muted-foreground/90">steer</b> nudges a
        run already in progress ·{" "}
        <b className="font-semibold text-muted-foreground/90">mode</b> sets how
        it runs
      </p>
    </div>
  );
}
