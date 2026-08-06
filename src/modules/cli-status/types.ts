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

/**
 * A private note a team member left its future self via its `memo` tool,
 * streamed as a live `agent` frame — like `team_message`, NOT folded into the
 * snapshot, so a consumer accumulates it client-side from the SSE feed (see
 * docs/arterm-cli-integration.md §6). Members run isolated per round: the
 * blackboard covers what a member SHARES, this covers what it KEEPS. `member`
 * is a member id matching `team[].id`; `round` is the 1-based team round;
 * `text` is truncated (~600 chars). `kind: "note"` is the only kind emitted
 * today — the contract says unknown kinds are ignorable, so the narrowing in
 * lib/memory.ts drops anything else.
 */
export type TeamMemoryEvent = StampedEvent & {
  type: "team_memory";
  round: number;
  member: string;
  memberName: string;
  kind: "note";
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
  /**
   * `ctx` is how full the model's context is, as the CLI's agent sees it —
   * reported prompt tokens when the provider sends them, an estimate of the
   * working history otherwise. `ctxWindow` is that model's real window when the
   * catalog knows it (absent on an unknown local model).
   */
  tokens: { in: number; out: number; ctx: number; ctxWindow?: number };
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
  /**
   * The permission prompt currently blocking the agent, answerable from here via
   * the `permission` control action (contract §8). Additive field: an older v1
   * CLI omits it entirely, so readers must treat `undefined` like `null`.
   */
  pendingPermission?: PendingPermission | null;
  /** Requests queued behind {@link pendingPermission} (sub-agents share one prompt). */
  pendingPermissionQueue?: number;
  /**
   * The failure that ended the most recent turn, `null` when it finished cleanly.
   * The CLI clears it when a new turn starts — it is the session's current health,
   * not its history (the event ring keeps that). Additive: an older v1 CLI omits it.
   */
  lastError?: StatusError | null;
  /**
   * The most recent model switch the fallback chain made, `null` when it has not
   * moved. Survives across turns on purpose: landing on a backup model is a
   * standing condition worth showing after the turn it rescued has ended.
   * Additive: an older v1 CLI omits it.
   */
  lastFallback?: StatusFallback | null;
  /**
   * Run spend. Optional because an older CLI does not send it — and absent is
   * "unknown", never zero. `reported: false` says the backend counted nothing,
   * which a local model does routinely; rendering that as a free run would be a
   * fiction the dashboard invented.
   */
  budget?: StatusBudget | null;
  /**
   * The execution boundary shell commands run inside, or null for the host.
   * `permissionMode` cannot tell these apart — yolo looks the same either way.
   */
  sandbox?: string | null;
  /** What the unattended-run guards did. Zero here is a real answer. */
  guards?: StatusGuards | null;
  /** Undoable turns, newest first (bounded by the CLI). */
  checkpoints?: { id: string; label: string; at: number }[];
  seq: number;
};

/** Provider failure taxonomy (contract §5) — lets a UI tell "out of quota" from
 *  "wrong API key" instead of printing one undifferentiated red line. */
export type ProviderErrorKind =
  | "network"
  | "timeout"
  | "auth"
  | "quota"
  | "overloaded"
  | "server"
  | "bad_request"
  | "unknown";

/** The failure that ended a turn. */
export type StatusError = {
  message: string;
  kind?: ProviderErrorKind;
  provider?: string;
  status?: number;
  /** True when the same request could plausibly succeed on a retry. */
  retryable?: boolean;
  /** Epoch ms when the failure was observed. */
  at: number;
};

/** The last model switch the fallback chain made (contract §5). */
export type StatusFallback = {
  from: { provider: string; model: string };
  to: { provider: string; model: string };
  reason: ProviderErrorKind;
  detail: string;
  at: number;
};

/**
 * A permission prompt the CLI is blocked on (contract §8). Normally it can only
 * be answered by typing in the terminal; the `permission` control action lets
 * the desktop answer it instead — which is the point, since a prompt raised in a
 * background tab otherwise stalls the agent unseen.
 */
export type PendingPermission = {
  /** Must be quoted back when answering; a stale id is rejected by the CLI. */
  id: string;
  tool: string;
  /** First line is the summary; the rest (if any) is a diff body. */
  preview: string;
  args: Record<string, unknown>;
  /** "read" | "edit" | "execute". */
  category: string;
  /** e.g. "destructive" — warrants a heavier confirmation. */
  riskTier?: string;
  requestedAt: number;
  /** The sub-agent that raised it. ABSENT means the main agent asked. */
  origin?: PermissionOrigin;
};

/**
 * Who is blocked on a prompt, when it isn't the main agent. A fan-out shares one
 * asker, so without this the card says only "write_file" — and with five
 * same-role workers on the graph there is no way to tell which one is waiting.
 *
 * `id` is the board-row id: the same value as `team[].id` and the
 * `team_member_state` / `team_member_event` events, so the UI can resolve it to
 * the exact topology node (and borrow its colour). It is absent for a `spawn`
 * sub-agent, which has a name but no row of its own.
 */
export type PermissionOrigin = {
  id?: string;
  name: string;
};

/** The three answers a permission prompt accepts (mirrors the TUI's y/a/n). */
export type PermissionAnswer = "allow" | "allow_always" | "deny";

export type ControlAction =
  | "pause"
  | "resume"
  | "stop"
  | "steer"
  | "goal"
  | "mode"
  | "permission";

/** Autonomy modes accepted by the `mode` control action. */
export type AutonomyMode = "once" | "eternal" | "parallel" | "phased" | "team";

/** Result of a control POST (`/api/control`). */
export type ControlResult = {
  ok: boolean;
  error?: string;
  state?: StatusSnapshot;
};

/** Run spend as the CLI reports it (`StatusBudget` in statusState.ts). */
export interface StatusBudget {
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  totalTokens: number;
  usd: number;
  limitTokens?: number;
  limitUsd?: number;
  breached: boolean;
  /** `usd` is a floor: some spend had no catalog price. */
  unpriced: boolean;
  /** False ⇒ the numbers above are "not reported", not "not spent". */
  reported: boolean;
}

/** Guard activity as the CLI reports it (`StatusGuards` in statusState.ts). */
export interface StatusGuards {
  loopSteers: number;
  loopCuts: number;
  extensions: number;
  lastVerdict: { pass: boolean; scope?: string; note?: string } | null;
}
