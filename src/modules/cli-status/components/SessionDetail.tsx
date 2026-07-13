import { CommandLineIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  agentCounts,
  computeKpis,
  type DerivedAgent,
  phaseProgress,
} from "../lib/dashboard";
import type { CliSessionEntry } from "../store/cliStatusStore";
import { AgentTimeline } from "./AgentTimeline";
import { AgentStatePill } from "./CliAtoms";
import { SessionControls } from "./SessionControls";
import { TopologyGraph, type TopologyMode } from "./TopologyGraph";

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="cli-mono flex items-center gap-2 px-4 pt-3.5 pb-1 text-[9.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80">
      {children}
      <span className="h-px flex-1 bg-border/60" />
    </div>
  );
}

const AUTONOMY_PILL: Record<string, string> = {
  running: "cli-pill-run",
  paused: "cli-pill-await",
  done: "cli-pill-done",
  stopped: "cli-pill-fail",
};
const STATUS_PILL: Record<string, string> = {
  thinking: "cli-pill-think",
  tool: "cli-pill-run",
  idle: "cli-pill-done",
};

export function SessionDetail({
  entry,
  entries,
  agents,
  selectedAgentId,
  onSelectAgent,
  onSelectSession,
  graphMode,
  onSetGraphMode,
  now,
  resolveTerminalFocus,
  active,
}: {
  entry: CliSessionEntry;
  /** All live entries — the "all sessions" topology view spans them. */
  entries: CliSessionEntry[];
  agents: DerivedAgent[];
  selectedAgentId: string | null;
  onSelectAgent: (id: string) => void;
  /** Focus a session (drives the shared dashboard selection). */
  onSelectSession: (id: string) => void;
  /** Topology view mode (lifted to the dashboard so it survives session switches). */
  graphMode: TopologyMode;
  onSetGraphMode: (mode: TopologyMode) => void;
  now: number;
  resolveTerminalFocus: (terminalId: number) => (() => void) | null;
  /** Dashboard tab visibility — gates the React-Flow mount (see TopologyGraph). */
  active: boolean;
}) {
  // Expand the graph to own the whole center (hides the footer rows). Declared
  // before any early return to satisfy the Rules of Hooks.
  const [maximized, setMaximized] = useState(false);
  const snap = entry.snapshot;
  if (!snap) {
    return (
      <div className="cli-mono flex flex-1 items-center justify-center text-[12px] text-muted-foreground">
        Connecting to {entry.info.cwd}…
      </div>
    );
  }
  const auto = snap.autonomy;
  const autonomyRunning = auto.state !== "idle";
  const pillCls = autonomyRunning
    ? (AUTONOMY_PILL[auto.state] ?? "cli-pill-done")
    : (STATUS_PILL[snap.status] ?? "cli-pill-done");
  const pillLabel = autonomyRunning
    ? `${auto.mode} · ${auto.state}`
    : snap.status;
  const termFocus =
    snap != null && entry.info.terminalId != null
      ? resolveTerminalFocus(entry.info.terminalId)
      : null;

  // `agents` = [main, ...members, ...workers] (see deriveSessionNodes). The graph
  // renders the whole tree; these splits feed the workers strip + timeline.
  const members = agents.filter((a) => a.kind === "member");
  const workers = agents.filter((a) => a.kind === "worker");
  const timelineAgents = agents.filter((a) => a.kind !== "worker");
  const counts = agentCounts(snap);
  // Topology header count follows the view: focused = this session, all = aggregate.
  const globalKpis = graphMode === "all" ? computeKpis(entries) : null;
  const topoRunning = globalKpis ? globalKpis.agentsRunning : counts.running;
  const topoTotal = globalKpis ? globalKpis.agentsTotal : counts.total;
  // Autonomy plan progress (phase done/current/pending derived from step).
  const phaseList = phaseProgress(auto.phases, auto.step);
  const phasesDone = phaseList.filter((p) => p.status === "done").length;
  const phasePct = auto.phases.length
    ? Math.round((phasesDone / auto.phases.length) * 100)
    : 0;
  const showGoalPanel =
    auto.state !== "idle" || auto.goal !== "" || auto.phases.length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* autonomy strip */}
      <div className="flex flex-wrap items-center gap-2.5 border-b border-border/50 px-4 py-3">
        <span className={cn("cli-pill cli-mono", pillCls)}>{pillLabel}</span>
        {auto.goal ? (
          <span className="text-[13px] text-muted-foreground">
            goal: <b className="font-semibold text-foreground">{auto.goal}</b>
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1.5">
          <span
            className="cli-mono rounded-full border px-2 py-0.5 text-[10px]"
            style={{
              color: "var(--cli-think)",
              borderColor:
                "color-mix(in oklab, var(--cli-think) 38%, transparent)",
            }}
          >
            {snap.permissionMode}
          </span>
          {entry.info.terminalId != null ? (
            termFocus ? (
              <button
                type="button"
                onClick={termFocus}
                title={`Focus terminal tab #${entry.info.terminalId}`}
                className="cli-mono inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] transition-colors"
                style={{
                  color: "var(--cli-accent)",
                  borderColor:
                    "color-mix(in oklab, var(--cli-accent) 45%, transparent)",
                }}
              >
                <HugeiconsIcon
                  icon={CommandLineIcon}
                  size={10}
                  strokeWidth={2}
                />
                tab {entry.info.terminalId}
              </button>
            ) : (
              <span className="cli-mono rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
                tab {entry.info.terminalId}
              </span>
            )
          ) : null}
          <span className="cli-mono text-[10.5px] text-muted-foreground/70">
            round {snap.rounds} · step {auto.step}
          </span>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {/* topology: the coordinator + members/workers as a graph, focused session
            or (toggle) every live session */}
        <div className="cli-mono flex items-center gap-2 px-4 pt-3.5 pb-1 text-[9.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80">
          Topology · {topoRunning}/{topoTotal} running
          <span className="h-px flex-1 bg-border/60" />
          <div className="inline-flex overflow-hidden rounded-md border border-border/70">
            {(["focused", "all"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => onSetGraphMode(m)}
                className={cn(
                  "cli-mono px-1.5 py-0.5 text-[8.5px] tracking-[0.1em] transition-colors",
                  graphMode === m
                    ? "bg-[color:var(--cli-accent)]/15 text-[color:var(--cli-accent)]"
                    : "text-muted-foreground/70 hover:text-foreground",
                )}
              >
                {m === "focused" ? "focused" : "all sessions"}
              </button>
            ))}
          </div>
        </div>

        {/* the graph is the dominant element — it grows to fill the center */}
        <div className="flex min-h-0 flex-1 flex-col px-4 pt-1 pb-1">
          <div className="min-h-0 flex-1">
            <TopologyGraph
              mode={graphMode}
              snapshot={snap}
              feed={entry.feed}
              entries={entries}
              selectedAgentId={selectedAgentId}
              selectedSessionId={entry.info.sessionId}
              onSelectAgent={onSelectAgent}
              onSelectSession={onSelectSession}
              onFocusSession={(id) => {
                onSelectSession(id);
                onSetGraphMode("focused");
              }}
              maximized={maximized}
              onToggleMaximize={() => setMaximized((v) => !v)}
              active={active}
            />
          </div>
          <div className="cli-mono shrink-0 px-0.5 pt-1.5 text-[9.5px] uppercase tracking-[0.14em] text-muted-foreground/60">
            {graphMode === "all"
              ? "every live session · click a session to focus it, an agent to inspect"
              : members.length > 0
                ? `▸ ${members.length} member${members.length === 1 ? "" : "s"} reporting to main · violet arcs = teammate messages · drag to rearrange, click a node to inspect`
                : "drag to rearrange · click a node to inspect"}
          </div>
        </div>

        {/* supplementary rows — compact, scrollable footer; hidden when the graph
            is maximized so it can own the whole center */}
        {!maximized ? (
          <div
            className="shrink-0 overflow-y-auto border-t border-border/40"
            style={{ maxHeight: 260 }}
          >
            {/* background fleet workers (parallel autonomy) */}
            {workers.length > 0 || snap.fleet.active > 0 ? (
              <>
                <SectionLabel>
                  Background workers · {workers.length || snap.fleet.active}
                </SectionLabel>
                <div className="flex flex-col gap-1 px-4 pt-1">
                  {workers.map((w) => (
                    <div
                      key={w.id}
                      className="flex items-center gap-2 rounded-lg border border-border/50 bg-card/40 px-2.5 py-1.5"
                    >
                      <span
                        className="inline-block size-1.5 shrink-0 rounded-full"
                        style={{ background: w.colorVar }}
                      />
                      <span className="cli-mono min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                        <span className="text-foreground/80">{w.name}</span>
                        {w.activity ? ` · ${w.activity}` : ""}
                      </span>
                      <AgentStatePill state={w.state} className="shrink-0" />
                    </div>
                  ))}
                  {workers.length === 0 && snap.fleet.active > 0 ? (
                    <div className="cli-mono text-[11px] text-muted-foreground/70">
                      {snap.fleet.active} parallel agent
                      {snap.fleet.active === 1 ? "" : "s"} running · round{" "}
                      {snap.fleet.round}
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}

            {/* goal / plan panel — the mission, autonomy state, and phase progress */}
            {showGoalPanel ? (
              <>
                <SectionLabel>Goal</SectionLabel>
                <div className="px-4 pt-1 pb-1">
                  {auto.goal ? (
                    <p className="text-[12px] leading-snug text-foreground/90">
                      <span
                        className="cli-mono"
                        style={{ color: "var(--cli-accent)" }}
                      >
                        ◎{" "}
                      </span>
                      {auto.goal}
                    </p>
                  ) : (
                    <p className="cli-mono text-[11px] text-muted-foreground/60">
                      no goal set — start an autonomous run from the controls
                      below
                    </p>
                  )}
                  <div className="cli-mono mt-1.5 flex items-center gap-2 text-[10px] text-muted-foreground/80">
                    <span
                      className={cn(
                        "cli-pill cli-mono",
                        AUTONOMY_PILL[auto.state] ?? "cli-pill-done",
                      )}
                    >
                      {auto.mode} · {auto.state}
                    </span>
                    {auto.phases.length > 0 ? (
                      <span>
                        {phasesDone}/{auto.phases.length} phases
                      </span>
                    ) : (
                      <span>step {auto.step}</span>
                    )}
                  </div>
                  {auto.phases.length > 0 ? (
                    <>
                      <div className="cli-meter mt-1.5">
                        <span
                          style={{
                            width: `${phasePct}%`,
                            background: "var(--cli-accent)",
                          }}
                        />
                      </div>
                      <ol className="mt-1.5 flex flex-col gap-0.5">
                        {phaseList.map(({ phase, status }) => (
                          <li
                            key={phase.id}
                            className="cli-mono flex items-center gap-1.5 text-[10.5px]"
                          >
                            <span
                              className="shrink-0"
                              style={{
                                color:
                                  status === "done"
                                    ? "var(--cli-run)"
                                    : status === "current"
                                      ? "var(--cli-accent)"
                                      : "var(--cli-idle)",
                              }}
                            >
                              {status === "done"
                                ? "✔"
                                : status === "current"
                                  ? "▶"
                                  : "○"}
                            </span>
                            <span
                              className={
                                status === "pending"
                                  ? "text-muted-foreground/60"
                                  : "text-foreground/85"
                              }
                            >
                              {phase.title}
                            </span>
                            {phase.parallel ? (
                              <span
                                title="parallel phase"
                                style={{ color: "var(--cli-accent)" }}
                              >
                                ∥
                              </span>
                            ) : null}
                            {phase.done ? (
                              <span className="min-w-0 flex-1 truncate text-muted-foreground/55">
                                — {phase.done}
                              </span>
                            ) : null}
                          </li>
                        ))}
                      </ol>
                    </>
                  ) : null}
                </div>
              </>
            ) : null}

            {/* timeline */}
            <SectionLabel>Timeline · last 4 min</SectionLabel>
            <div className="px-4 pt-1.5 pb-2">
              <AgentTimeline agents={timelineAgents} now={now} />
            </div>
          </div>
        ) : null}
      </div>

      {/* controls */}
      <div className="border-t border-border/50 px-4 py-3">
        <SessionControls
          sessionId={entry.info.sessionId}
          autonomyState={auto.state}
          mode={auto.mode}
        />
      </div>
    </div>
  );
}
