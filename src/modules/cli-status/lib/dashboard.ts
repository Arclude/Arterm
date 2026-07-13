// Pure view-model helpers for the CLI Agents dashboard. Everything here derives
// from the StatusSnapshot the store already holds — no invented data. Kept
// separate from the components so the mapping is testable in isolation.

import type { CliSessionEntry } from "../store/cliStatusStore";
import type {
  AutonomyPhase,
  StatusSnapshot,
  TeamMemberStatus,
  WorkerStatus,
} from "../types";

/** 8-color agent identity palette (CSS-var names defined in dashboard.css). */
const AGENT_COLOR_ORDER = [
  "cyan",
  "blue",
  "green",
  "purple",
  "orange",
  "pink",
  "yellow",
  "red",
] as const;

/** Stable per-agent color, by index within the session's team. */
export function agentColorVar(index: number): string {
  const name = AGENT_COLOR_ORDER[index % AGENT_COLOR_ORDER.length];
  return `var(--cli-a-${name})`;
}

/** Display state for an agent card / dot. Superset of the contract's member
 *  states plus the session-derived `thinking`/`idle` used by a synthesized main. */
export type AgentDisplayState =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "thinking"
  | "idle";

/** Where an agent sits in the (2-level) topology: the single coordinator, one
 *  of its team members, or a background fleet worker. */
export type AgentKind = "main" | "member" | "worker";

export type DerivedAgent = {
  id: string;
  name: string;
  kind: AgentKind;
  adhoc: boolean;
  state: AgentDisplayState;
  activity: string;
  glyph: string;
  /** null = telemetry not tracked for this agent (e.g. a synthesized main). */
  toolUseCount: number | null;
  tokenCount: number;
  recentActivities: string[];
  filesChanged: number | null;
  startedAt?: number;
  lastActivityAt?: number;
  colorVar: string;
};

const GLYPH_BY_STATE: Record<AgentDisplayState, string> = {
  running: "⚙",
  thinking: "✎",
  done: "✔",
  failed: "✘",
  pending: "•",
  idle: "•",
};

/** Prefer the glyph already embedded in the activity string ("⚙ grep"), else
 *  fall back to a state glyph. Never invents a tool it can't see. */
function glyphFor(
  state: AgentDisplayState,
  activity: string | undefined,
): string {
  const lead = activity?.trim()?.[0];
  if (lead && "⚙✎⊘✔✘?".includes(lead)) return lead;
  return GLYPH_BY_STATE[state];
}

function memberToAgent(m: TeamMemberStatus, index: number): DerivedAgent {
  const state: AgentDisplayState = m.state;
  return {
    id: m.id,
    name: m.name,
    kind: "member",
    adhoc: m.adhoc,
    state,
    activity: m.activity ?? "",
    glyph: glyphFor(state, m.activity),
    toolUseCount: m.toolUseCount,
    tokenCount: m.tokenCount,
    recentActivities: m.recentActivities ?? [],
    filesChanged: m.filesChanged ?? 0,
    startedAt: m.startedAt,
    lastActivityAt: m.lastActivityAt,
    colorVar: agentColorVar(index),
  };
}

/** The coordinator card, synthesized from the snapshot's top-level status/tokens
 *  plus its live `main` telemetry. Always present — every session has a main,
 *  and team members / workers hang off it as children (contract: 2-level tree). */
function synthesizeMain(snapshot: StatusSnapshot): DerivedAgent {
  // Additive field: an older v1 CLI omits `main`, so default it defensively.
  const main = snapshot.main ?? { toolUseCount: 0, recentActivities: [] };
  const state: AgentDisplayState =
    snapshot.status === "tool"
      ? "running"
      : snapshot.status === "thinking"
        ? "thinking"
        : "idle";
  const activity = snapshot.activeTool
    ? `⚙ ${snapshot.activeTool}`
    : state === "thinking"
      ? "thinking"
      : state === "running"
        ? "working"
        : "idle";
  return {
    id: "main",
    name: "main",
    kind: "main",
    adhoc: false,
    state,
    activity,
    glyph: glyphFor(state, activity),
    toolUseCount: main.toolUseCount,
    tokenCount: snapshot.tokens.in + snapshot.tokens.out,
    recentActivities: main.recentActivities ?? [],
    filesChanged: null,
    startedAt: snapshot.startedAt,
    colorVar: agentColorVar(0),
  };
}

/** A background fleet worker as a light agent card. Workers carry only a task /
 *  role / state (no per-worker token or tool telemetry in the protocol). */
function workerToAgent(w: WorkerStatus, index: number): DerivedAgent {
  const state: AgentDisplayState = w.state === "running" ? "running" : "done";
  const activity = w.task ?? "";
  return {
    id: `worker-${index}`,
    name: w.role?.trim() || "worker",
    kind: "worker",
    adhoc: false,
    state,
    activity,
    glyph: glyphFor(state, activity),
    toolUseCount: null, // not tracked per worker
    tokenCount: 0,
    recentActivities: [],
    filesChanged: null,
    colorVar: agentColorVar(index),
  };
}

/** The agent nodes for a session: the main coordinator FIRST, then its team
 *  members as children. Main is always present (single-agent sessions show just
 *  it). Colors are offset so main and the members never collide. */
export function deriveAgents(snapshot: StatusSnapshot): DerivedAgent[] {
  return [
    synthesizeMain(snapshot),
    ...snapshot.team.map((m, i) => memberToAgent(m, i + 1)),
  ];
}

/** The background fleet workers for a session (empty when none). Colors continue
 *  the palette after main + team so every node in the topology stays distinct. */
export function deriveWorkers(snapshot: StatusSnapshot): DerivedAgent[] {
  const base = 1 + snapshot.team.length;
  return snapshot.workers.map((w, i) => workerToAgent(w, base + i));
}

/** Every node in a session's topology, in stable order: the main coordinator,
 *  its team members, then its fleet workers. Used both for the topology graph
 *  and for selection/drilldown resolution (so any node is inspectable). */
export function deriveSessionNodes(snapshot: StatusSnapshot): DerivedAgent[] {
  return [...deriveAgents(snapshot), ...deriveWorkers(snapshot)];
}

/**
 * Authoritative agent counts for a session, aligned with the rail badge.
 * `running` is the server-computed `activeAgents` (main + running team + running
 * workers + fleet.active); `total` is every known node (main + team + workers +
 * fleet). Using the server value keeps the dashboard from collapsing to "1/1"
 * during parallel-autonomy, where the fleet has no per-agent roster.
 */
export function agentCounts(snapshot: StatusSnapshot): {
  running: number;
  total: number;
} {
  return {
    running: snapshot.activeAgents,
    total:
      1 +
      snapshot.team.length +
      snapshot.workers.length +
      snapshot.fleet.active,
  };
}

const ACTIVE_STATES: ReadonlySet<AgentDisplayState> = new Set([
  "running",
  "thinking",
]);

export function isActiveAgent(a: DerivedAgent): boolean {
  return ACTIVE_STATES.has(a.state);
}

/**
 * Gauge value (0–100) = this agent's share of the session's work, by tokens
 * (falling back to tool uses when no tokens are recorded yet). Honest relative
 * intensity, not a fabricated completion bar.
 */
export function shareOfWork(
  agent: DerivedAgent,
  peers: DerivedAgent[],
): number {
  const byTokens = peers.some((p) => p.tokenCount > 0);
  const value = byTokens ? agent.tokenCount : (agent.toolUseCount ?? 0);
  const max = Math.max(
    ...peers.map((p) => (byTokens ? p.tokenCount : (p.toolUseCount ?? 0))),
    1,
  );
  return Math.round((value / max) * 100);
}

export type DashboardKpis = {
  sessions: number;
  agentsRunning: number;
  agentsTotal: number;
  tools: number;
  tokens: number;
};

/**
 * Aggregate KPIs across the live-connected sessions only. Agent counts come from
 * {@link agentCounts} (the server-authoritative `activeAgents` + full roster) so
 * the header agrees with the rail badge even under parallel-autonomy. Tools sum
 * the main agent plus every team member.
 */
export function computeKpis(entries: CliSessionEntry[]): DashboardKpis {
  const kpis: DashboardKpis = {
    sessions: 0,
    agentsRunning: 0,
    agentsTotal: 0,
    tools: 0,
    tokens: 0,
  };
  for (const e of entries) {
    if (e.connection !== "live" || !e.snapshot) continue;
    const s = e.snapshot;
    kpis.sessions += 1;
    kpis.tokens += s.tokens.in + s.tokens.out;
    const counts = agentCounts(s);
    kpis.agentsRunning += counts.running;
    kpis.agentsTotal += counts.total;
    kpis.tools += (s.main?.toolUseCount ?? 0) + tallyMemberTools(s);
  }
  return kpis;
}

function tallyMemberTools(s: StatusSnapshot): number {
  let n = 0;
  for (const m of s.team) n += m.toolUseCount;
  return n;
}

export type PhaseStatus = "done" | "current" | "pending";

/** Phase completion derived from the autonomy `step` index: phases before the
 *  current step are done, the step's phase is current, later ones pending. `step`
 *  past the end ⇒ all done. Pure — the `phases[].done` field is a human criterion,
 *  not a boolean, so completion comes from `step`. */
export function phaseProgress(
  phases: AutonomyPhase[],
  step: number,
): { phase: AutonomyPhase; status: PhaseStatus }[] {
  return phases.map((phase, i) => ({
    phase,
    status: i < step ? "done" : i === step ? "current" : "pending",
  }));
}

/** Session ordering shared by every CLI Agents surface (dashboard, rail flyout,
 *  sidebar panel): busy sessions first, then most-recently-started. Returns a new
 *  array — never mutates the store's values. */
export function sortSessionEntries(
  entries: CliSessionEntry[],
): CliSessionEntry[] {
  return [...entries].sort((a, b) => {
    const aBusy = (a.snapshot?.activeAgents ?? 0) > 0 ? 1 : 0;
    const bBusy = (b.snapshot?.activeAgents ?? 0) > 0 ? 1 : 0;
    if (aBusy !== bBusy) return bBusy - aBusy;
    return b.info.startedAt - a.info.startedAt;
  });
}

/** One-line activity summary for a session row — connection- and snapshot-aware.
 *  Prefers the concrete tool, then a running autonomy goal, then the raw status. */
export function sessionActivity(entry: CliSessionEntry): string {
  if (entry.connection === "lost") return "connection lost";
  const s = entry.snapshot;
  if (!s) return "connecting…";
  if (s.activeTool) return `⚙ ${s.activeTool}`;
  if (s.autonomy.state === "running" && s.autonomy.goal) return s.autonomy.goal;
  if (s.status === "thinking") return "thinking…";
  return "idle";
}

/** Compact number: 950, 1.2k, 15k, 1.3M. */
export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Elapsed seconds → "2m05s" / "45s". */
export function fmtElapsed(seconds: number): string {
  if (seconds < 0) return "0s";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m${String(s).padStart(2, "0")}s`;
}

/** Last path segment of a cwd (handles both separators). */
export function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] as string) : p;
}

/** Idle for longer than this ⇒ treat an otherwise-active agent as paused. */
export const IDLE_MS = 10_000;

/** Build an SVG path (line + area) for a sparkline; null when too few points. */
export function sparkPath(
  values: number[],
  w: number,
  h: number,
): { line: string; area: string } | null {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const min = Math.min(...values);
  const span = max - min || 1;
  const step = w / (values.length - 1);
  const pts = values.map((v, i) => {
    const x = i * step;
    const y = h - ((v - min) / span) * (h - 3) - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const line = `M${pts.join(" L")}`;
  const area = `${line} L${w},${h} L0,${h} Z`;
  return { line, area };
}
