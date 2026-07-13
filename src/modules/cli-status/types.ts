// Types for the Arterm-CLI <-> desktop status protocol (v1).
// Transcribed from docs/arterm-cli-integration.md — the source of truth. Keep
// in sync with that contract; additive fields do not bump `v`.

/**
 * A discovery-file entry as returned by the Rust `arterm_cli_list_sessions`
 * command. Naming is camelCase to match the discovery file on disk and the
 * command's serde output.
 */
export type CliSessionInfo = {
  v: number;
  pid: number;
  sessionId: string;
  port: number;
  token: string;
  cwd: string;
  model?: string | null;
  provider?: string | null;
  startedAt: number;
  terminalId?: number | null;
};

/**
 * A CLI bus event stamped at the sink. `type` discriminates the payload; the
 * desktop treats the rest as opaque and renders a compact summary.
 */
export type StampedEvent = {
  seq: number;
  ts: number;
  type: string;
} & Record<string, unknown>;

/**
 * A blackboard posting, streamed as a live `agent` frame — NOT folded into the
 * snapshot, so a consumer accumulates it client-side from the SSE feed (see
 * docs/desktop-integration.md §6). `kind:"message"` with `to` set is a directed
 * member→member note (the topology graph's member↔member edge); without `to`
 * it's a broadcast; `kind:"result"` is a member's round output posted to the
 * board (`to` always absent). `from`/`to` are member ids matching `team[].id`
 * (or `"leader"` for `from`); `round` is the 1-based team round.
 */
export type TeamMessageEvent = StampedEvent & {
  type: "team_message";
  round: number;
  from: string;
  fromName: string;
  to?: string;
  toName?: string;
  kind: "result" | "message";
  text: string;
};

export type TeamMemberState = "pending" | "running" | "done" | "failed";

export type TeamMemberStatus = {
  id: string;
  name: string;
  description: string;
  adhoc: boolean;
  state: TeamMemberState;
  task?: string;
  activity?: string;
  filesChanged?: number;
  // Live per-member telemetry, accumulated server-side (present in every snapshot).
  toolUseCount: number; // count of the member's tool_call events
  tokenCount: number; // sum of the member's prompt + completion tokens
  recentActivities: string[]; // rolling window (max 5), newest last
  startedAt?: number; // epoch ms of first `running` transition → elapsed
  lastActivityAt?: number; // epoch ms of the member's most recent activity → idle
};

export type SessionStatus = "idle" | "thinking" | "tool";

export type AutonomyState = "idle" | "running" | "paused" | "done" | "stopped";

export type AutonomyPhase = {
  id: string;
  title: string;
  done: string;
  parallel?: boolean;
};

export type AutonomyTeamMember = {
  id: string;
  name: string;
  description: string;
  adhoc: boolean;
};

export type WorkerStatus = {
  task: string;
  role?: string;
  state: "running" | "done";
  output?: string;
};

export type StatusSnapshot = {
  v: 1;
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  status: SessionStatus;
  model: string;
  provider: string;
  permissionMode: string;
  toolCount: number;
  tokens: { in: number; out: number; ctx: number };
  activeTool: string | null;
  rounds: number;
  autonomy: {
    state: AutonomyState;
    mode: string;
    goal: string;
    step: number;
    phases: AutonomyPhase[];
    team: AutonomyTeamMember[];
  };
  fleet: { active: number; round: number };
  workers: WorkerStatus[];
  team: TeamMemberStatus[];
  /**
   * Live telemetry for the primary (non-member) agent, accumulated server-side
   * from top-level `tool_call` / `assistant_message` events — same format as a
   * member's. Additive field: the current CLI always emits it, but an older v1
   * CLI omits it, so the consumer type is optional and every reader defaults it
   * (`snapshot.main ?? { toolUseCount: 0, recentActivities: [] }`).
   */
  main?: { toolUseCount: number; recentActivities: string[] };
  activeAgents: number;
  seq: number;
};

export type ControlAction =
  | "pause"
  | "resume"
  | "stop"
  | "steer"
  | "goal"
  | "mode";

/** Autonomy modes accepted by the `mode` control action. */
export type AutonomyMode = "once" | "eternal" | "parallel" | "phased" | "team";

/** Result of a control POST (`/api/control`). */
export type ControlResult = {
  ok: boolean;
  error?: string;
  state?: StatusSnapshot;
};
