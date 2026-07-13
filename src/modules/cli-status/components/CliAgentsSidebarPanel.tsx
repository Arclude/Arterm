import "../dashboard.css";
import { useCallback, useMemo } from "react";
import { computeKpis, sortSessionEntries } from "../lib/dashboard";
import { useCliStatusStore } from "../store/cliStatusStore";
import { StatusDot } from "./CliAtoms";
import { SessionNavigator } from "./SessionNavigator";

export type CliAgentsSidebarPanelProps = {
  /** Open (or focus) the main-area CLI Agents dashboard tab — called on a row
   *  click so selecting a session in the sidebar also surfaces its full graph. */
  onOpenSession: () => void;
};

/**
 * The CLI Agents sidebar view — a compact, live companion to the main-area
 * dashboard. Lists every running `arterm` session (reusing the dashboard's
 * SessionNavigator rows) and drives the SHARED selected-session state, so a click
 * here focuses that session in the dashboard graph. Wrapped in `.cli-dash` for the
 * palette; styled to sit natively beside the Files / Debug / SSH panels.
 */
export function CliAgentsSidebarPanel({
  onOpenSession,
}: CliAgentsSidebarPanelProps) {
  const sessions = useCliStatusStore((s) => s.sessions);
  const selectedSessionId = useCliStatusStore((s) => s.selectedSessionId);
  const selectSession = useCliStatusStore((s) => s.selectSession);

  const entries = useMemo(
    () => sortSessionEntries(Object.values(sessions)),
    [sessions],
  );
  const kpis = useMemo(() => computeKpis(entries), [entries]);

  const handleSelect = useCallback(
    (sessionId: string) => {
      selectSession(sessionId);
      onOpenSession();
    },
    [selectSession, onOpenSession],
  );

  return (
    <div className="cli-dash flex h-full min-h-0 flex-col bg-card text-foreground">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2.5">
        <span className="cli-mono text-[12px] font-semibold text-foreground">
          CLI Agents
        </span>
        {kpis.agentsRunning > 0 ? <StatusDot variant="run" /> : null}
        <span className="cli-mono ml-auto text-[10.5px] tabular-nums text-muted-foreground">
          {entries.length} session{entries.length === 1 ? "" : "s"} ·{" "}
          {kpis.agentsRunning} running
        </span>
      </div>

      {entries.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center px-4 text-center">
          <p className="text-[12px] text-muted-foreground">
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
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto pt-1.5">
          <SessionNavigator
            entries={entries}
            selectedId={selectedSessionId}
            onSelect={handleSelect}
          />
        </div>
      )}
    </div>
  );
}
