import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "../dashboard.css";
import { cn } from "@/lib/utils";
import {
  compact,
  computeKpis,
  deriveSessionNodes,
  sortSessionEntries,
  sparkPath,
} from "../lib/dashboard";
import { buildGlobalFeed } from "../lib/feed";
import { useCliStatusStore } from "../store/cliStatusStore";
import { AgentDrilldown } from "./AgentDrilldown";
import { BlackboardPanel } from "./BlackboardPanel";
import { GlobalFeed } from "./GlobalFeed";
import { SessionDetail } from "./SessionDetail";
import { SessionNavigator } from "./SessionNavigator";
import type { TopologyMode } from "./TopologyGraph";
import { TranscriptConsole } from "./TranscriptConsole";

type RightTab = "inspect" | "console" | "blackboard";

const GRAPH_MODE_KEY = "arterm.cli.graphMode";
function readGraphMode(): TopologyMode {
  try {
    const v = window.localStorage.getItem(GRAPH_MODE_KEY);
    if (v === "focused" || v === "all") return v;
  } catch {
    // storage may fail in private mode
  }
  return "focused";
}

export type CliAgentsDashboardProps = {
  /** Returns a focus callback when a `terminalId` maps to an open terminal tab. */
  resolveTerminalFocus: (terminalId: number) => (() => void) | null;
  /** Whether the dashboard tab is the active/visible tab. Threaded to the
   *  topology graph so React-Flow only mounts while visible (it leaks over the
   *  active tab otherwise — the tab is kept mounted + `visibility:hidden`). */
  visible: boolean;
};

const SPARK_CAP = 48;
const SPARK_W = 168;
const SPARK_H = 26;

function Kpi({
  label,
  children,
  wide,
}: {
  label: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className="rounded-[10px] border border-border/70 bg-card/60 px-3 py-2"
      style={{ minWidth: wide ? 168 : 92 }}
    >
      <div className="cli-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground/80">
        {label}
      </div>
      <div className="cli-mono text-[20px] font-bold leading-tight text-foreground">
        {children}
      </div>
    </div>
  );
}

export function CliAgentsDashboard({
  resolveTerminalFocus,
  visible,
}: CliAgentsDashboardProps) {
  const sessions = useCliStatusStore((s) => s.sessions);
  // Session focus is shared with the sidebar panel (both drive one selection).
  const selSession = useCliStatusStore((s) => s.selectedSessionId);
  const setSelSession = useCliStatusStore((s) => s.selectSession);

  const entries = useMemo(
    () => sortSessionEntries(Object.values(sessions)),
    [sessions],
  );

  const kpis = useMemo(() => computeKpis(entries), [entries]);
  const feed = useMemo(() => buildGlobalFeed(entries), [entries]);

  const [selAgent, setSelAgent] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<RightTab>("inspect");

  // Topology view mode, lifted here (not in SessionDetail, which remounts on
  // session change) and persisted so the choice survives reloads.
  const [graphMode, setGraphModeState] = useState<TopologyMode>(readGraphMode);
  const setGraphMode = useCallback((mode: TopologyMode) => {
    setGraphModeState(mode);
    try {
      window.localStorage.setItem(GRAPH_MODE_KEY, mode);
    } catch {
      // ignore
    }
  }, []);

  // Resolve selections against the live data without effects (falls back to the
  // first item), so a vanished session/agent can never strand the view.
  const resolvedSessionId =
    selSession && entries.some((e) => e.info.sessionId === selSession)
      ? selSession
      : (entries[0]?.info.sessionId ?? null);
  const currentEntry =
    entries.find((e) => e.info.sessionId === resolvedSessionId) ?? null;
  const agents = currentEntry?.snapshot
    ? deriveSessionNodes(currentEntry.snapshot)
    : [];
  const resolvedAgentId =
    selAgent && agents.some((a) => a.id === selAgent)
      ? selAgent
      : (agents[0]?.id ?? null);
  const selectedAgent = agents.find((a) => a.id === resolvedAgentId) ?? null;

  // Shared 1s clock so every elapsed counter + the timeline advance together.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  // Local token-over-time samples for the header sparkline (real data or none).
  const tokensRef = useRef(0);
  tokensRef.current = kpis.tokens;
  const [spark, setSpark] = useState<number[]>([]);
  useEffect(() => {
    const push = () =>
      setSpark((prev) => {
        const next = [...prev, tokensRef.current];
        return next.length > SPARK_CAP
          ? next.slice(next.length - SPARK_CAP)
          : next;
      });
    push();
    const t = window.setInterval(push, 2000);
    return () => window.clearInterval(t);
  }, []);
  const sp = sparkPath(spark, SPARK_W, SPARK_H);

  if (entries.length === 0) {
    return (
      <div className="cli-dash flex h-full min-h-0 flex-col items-center justify-center bg-background text-center text-foreground">
        <p className="text-[13px] text-muted-foreground">
          No running Arterm CLI sessions.
        </p>
        <p className="cli-mono pt-1.5 text-[11.5px] text-muted-foreground/70">
          Run{" "}
          <code className="rounded bg-foreground/[0.08] px-1 py-0.5">
            arterm
          </code>{" "}
          in any terminal.
        </p>
      </div>
    );
  }

  return (
    <div className="cli-dash flex h-full min-h-0 flex-col bg-background text-foreground">
      {/* header + KPIs */}
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-5 py-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="cli-mono text-[17px] font-bold">CLI Agents</h1>
          {kpis.sessions > 0 ? (
            <span
              className="cli-mono inline-flex items-center gap-1.5 text-[11px]"
              style={{ color: "var(--cli-run)" }}
            >
              <span
                className="cli-dot cli-dot-run"
                style={{ width: 7, height: 7 }}
              />
              live
            </span>
          ) : null}
          <span className="text-[12.5px] text-muted-foreground">
            monitoring every <code className="cli-mono">arterm</code> session
            across your terminals
          </span>
        </div>
        <div className="flex flex-wrap gap-2.5">
          <Kpi label="Sessions">{kpis.sessions}</Kpi>
          <Kpi label="Agents">
            {kpis.agentsRunning}
            <small className="text-[11px] font-medium text-muted-foreground/70">
              /{kpis.agentsTotal}
            </small>
          </Kpi>
          <Kpi label="Tools">{compact(kpis.tools)}</Kpi>
          <Kpi label="Tokens" wide>
            {compact(kpis.tokens)}
            {sp ? (
              <svg
                className="mt-0.5 block h-[26px] w-full"
                viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <path d={sp.area} fill="var(--cli-accent)" opacity="0.13" />
                <path
                  d={sp.line}
                  fill="none"
                  stroke="var(--cli-accent)"
                  strokeWidth="1.6"
                  strokeLinejoin="round"
                />
              </svg>
            ) : null}
          </Kpi>
        </div>
      </header>

      {/* 3-column body */}
      <div className="grid min-h-0 flex-1 grid-cols-[232px_minmax(0,1fr)_320px]">
        {/* left: session navigator */}
        <div className="flex min-h-0 flex-col overflow-y-auto border-r border-border bg-card/30">
          <div className="cli-mono px-4 pt-3 pb-1.5 text-[9.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80">
            Sessions
          </div>
          <SessionNavigator
            entries={entries}
            selectedId={resolvedSessionId}
            onSelect={setSelSession}
          />
        </div>

        {/* center: focused session */}
        {currentEntry ? (
          <SessionDetail
            key={currentEntry.info.sessionId}
            entry={currentEntry}
            entries={entries}
            agents={agents}
            selectedAgentId={resolvedAgentId}
            onSelectAgent={setSelAgent}
            onSelectSession={setSelSession}
            graphMode={graphMode}
            onSetGraphMode={setGraphMode}
            now={now}
            resolveTerminalFocus={resolveTerminalFocus}
            active={visible}
          />
        ) : (
          <div />
        )}

        {/* right: inspect (drill-down + feed) or the live console */}
        <div className="flex min-h-0 flex-col border-l border-border bg-card/30">
          <div className="flex items-center gap-1 border-b border-border px-3 py-2">
            {(["inspect", "console", "blackboard"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setRightTab(t)}
                className={cn(
                  "cli-mono rounded-md px-2 py-0.5 text-[9px] uppercase tracking-[0.12em] transition-colors",
                  rightTab === t
                    ? "bg-[color:var(--cli-accent)]/15 text-[color:var(--cli-accent)]"
                    : "text-muted-foreground/70 hover:text-foreground",
                )}
              >
                {t === "blackboard" ? "board" : t}
              </button>
            ))}
          </div>
          {rightTab === "blackboard" ? (
            <BlackboardPanel feed={currentEntry?.feed ?? []} />
          ) : rightTab === "console" ? (
            <TranscriptConsole
              feed={currentEntry?.feed ?? []}
              agents={agents}
            />
          ) : (
            <>
              <div className="border-b border-border px-4 pt-3 pb-3">
                {selectedAgent ? (
                  <AgentDrilldown agent={selectedAgent} now={now} />
                ) : (
                  <div className="cli-mono text-[11px] text-muted-foreground/60">
                    Select an agent to inspect.
                  </div>
                )}
              </div>
              <GlobalFeed rows={feed} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
