import { cn } from "@/lib/utils";
import type { AgentDisplayState } from "../lib/dashboard";
import type { CliSessionEntry } from "../store/cliStatusStore";

export type DotVariant =
  | "run"
  | "think"
  | "idle"
  | "done"
  | "fail"
  | "await"
  | "lost";

const DOT_CLASS: Record<DotVariant, string> = {
  run: "cli-dot-run",
  think: "cli-dot-think",
  idle: "cli-dot-idle",
  done: "cli-dot-done",
  fail: "cli-dot-fail",
  await: "cli-dot-await",
  lost: "cli-dot-lost",
};

export function StatusDot({
  variant,
  className,
}: {
  variant: DotVariant;
  className?: string;
}) {
  return <span className={cn("cli-dot", DOT_CLASS[variant], className)} />;
}

/** Status-dot variant for a whole session, from its connection + snapshot. */
export function sessionDotVariant(entry: CliSessionEntry): DotVariant {
  if (entry.connection === "lost") return "lost";
  const s = entry.snapshot;
  if (!s) return "idle";
  if (s.status === "tool" || s.autonomy.state === "running") return "run";
  if (s.status === "thinking") return "think";
  return "idle";
}

export function agentDotVariant(state: AgentDisplayState): DotVariant {
  switch (state) {
    case "running":
      return "run";
    case "thinking":
      return "think";
    case "done":
      return "done";
    case "failed":
      return "fail";
    default:
      return "idle";
  }
}

const PILL: Record<AgentDisplayState, { cls: string; label: string }> = {
  running: { cls: "cli-pill-run", label: "running" },
  thinking: { cls: "cli-pill-think", label: "thinking" },
  done: { cls: "cli-pill-done", label: "done" },
  failed: { cls: "cli-pill-fail", label: "failed" },
  pending: { cls: "cli-pill-done", label: "pending" },
  idle: { cls: "cli-pill-done", label: "idle" },
};

export function AgentStatePill({
  state,
  className,
}: {
  state: AgentDisplayState;
  className?: string;
}) {
  const { cls, label } = PILL[state];
  return (
    <span className={cn("cli-pill cli-mono", cls, className)}>{label}</span>
  );
}
