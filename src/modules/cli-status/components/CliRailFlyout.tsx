import "../dashboard.css";
import { cn } from "@/lib/utils";
import {
  agentCounts,
  basename,
  computeKpis,
  sessionActivity,
  sortSessionEntries,
} from "../lib/dashboard";
import { useCliStatusStore } from "../store/cliStatusStore";
import { StatusDot, sessionDotVariant } from "./CliAtoms";

export type CliRailFlyoutProps = {
  /** Open (or focus) the CLI Agents dashboard tab in the workspace area. */
  onOpenDashboard: () => void;
  /** Returns a focus callback when a `terminalId` maps to an open terminal tab. */
  resolveTerminalFocus: (terminalId: number) => (() => void) | null;
};

/**
 * Live hover summary for the CLI Agents rail button — every running `arterm`
 * session at a glance (status, agents running, current activity), with a
 * click-through to the full dashboard. Rendered inside a portaled HoverCard, so
 * it carries its own `.cli-dash` var scope for the status-dot colors.
 */
export function CliRailFlyout({
  onOpenDashboard,
  resolveTerminalFocus,
}: CliRailFlyoutProps) {
  const sessions = useCliStatusStore((s) => s.sessions);
  const entries = sortSessionEntries(Object.values(sessions));

  if (entries.length === 0) {
    return (
      <div className="px-4 py-3.5">
        <div className="cli-mono text-[12px] font-semibold text-foreground">
          CLI Agents
        </div>
        <p className="pt-1 text-[11.5px] text-muted-foreground">
          No running Arterm CLI sessions.
        </p>
        <p className="cli-mono pt-1.5 text-[11px] text-muted-foreground/70">
          Run{" "}
          <code className="rounded bg-foreground/[0.08] px-1 py-0.5">
            arterm
          </code>{" "}
          in any terminal.
        </p>
      </div>
    );
  }

  const kpis = computeKpis(entries);

  return (
    <div className="flex max-h-[min(60vh,440px)] flex-col">
      <div className="flex items-center gap-2 border-b border-border/60 px-3.5 py-2.5">
        <span className="cli-mono text-[12px] font-semibold text-foreground">
          CLI Agents
        </span>
        {kpis.agentsRunning > 0 ? <StatusDot variant="run" /> : null}
        <span className="cli-mono ml-auto text-[10.5px] text-muted-foreground">
          {kpis.agentsRunning} running · {kpis.agentsTotal} agent
          {kpis.agentsTotal === 1 ? "" : "s"}
        </span>
      </div>

      <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto p-1.5">
        {entries.map((entry) => {
          const { info, snapshot } = entry;
          const counts = snapshot ? agentCounts(snapshot) : null;
          const model = snapshot?.model ?? info.model ?? "";
          const focus =
            info.terminalId != null
              ? resolveTerminalFocus(info.terminalId)
              : null;
          const lost = entry.connection === "lost";
          return (
            <button
              key={info.sessionId}
              type="button"
              onClick={onOpenDashboard}
              className={cn(
                "group grid w-full grid-cols-[auto_1fr_auto] items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left outline-none transition-colors",
                "hover:bg-foreground/[0.05] focus-visible:bg-foreground/[0.06]",
                lost && "opacity-60",
              )}
            >
              <StatusDot variant={sessionDotVariant(entry)} />
              <div className="min-w-0">
                <div
                  className="cli-mono truncate text-[11.5px] font-semibold text-foreground"
                  title={info.cwd}
                >
                  {basename(info.cwd)}
                </div>
                <div className="cli-mono truncate text-[10px] text-muted-foreground/80">
                  {model}
                  {info.terminalId != null ? ` · tab ${info.terminalId}` : ""}
                </div>
                <div className="cli-mono truncate text-[10px] text-muted-foreground/70">
                  {sessionActivity(entry)}
                </div>
              </div>
              <div className="flex flex-col items-end gap-1">
                <span className="cli-mono text-[10px] tabular-nums text-muted-foreground/70">
                  {counts ? `${counts.running}/${counts.total}` : "…"}
                </span>
                {focus ? (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      focus();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        e.stopPropagation();
                        focus();
                      }
                    }}
                    className="cli-mono rounded border border-border/60 px-1 text-[9px] text-muted-foreground/80 opacity-0 outline-none transition-opacity hover:bg-foreground/[0.06] focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    ↗ tab
                  </span>
                ) : null}
              </div>
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={onOpenDashboard}
        className="cli-mono border-t border-border/60 px-3.5 py-2 text-left text-[11px] font-medium text-[color:var(--cli-accent)] outline-none transition-colors hover:bg-foreground/[0.04] focus-visible:bg-foreground/[0.06]"
      >
        Open dashboard →
      </button>
    </div>
  );
}
