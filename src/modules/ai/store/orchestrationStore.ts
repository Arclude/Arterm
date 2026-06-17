import { create } from "zustand";

/**
 * Orchestration ("agent team") state.
 *
 * A team run is started by the lead/orchestrator session when it calls the
 * `run_agent_team` tool. The lead splits a goal into subtasks and spawns one
 * worker session per subtask (via `spawnAgentSession`, running in the
 * background). This store tracks the parent↔worker relationship and each
 * worker's live phase so the Agents panel can render the team as a tree.
 *
 * Mirrors the lightweight pattern of `managedAgentsStore` — pure UI/coordination
 * state, no side effects. The actual work runs inside each worker's own Chat;
 * worker run-status (thinking/streaming/idle) lives in chatStore.metaBySession.
 */

export type TeamWorkerStatus = "running" | "done" | "error";

export type TeamWorker = {
  /** Background chat session backing this worker. */
  sessionId: string;
  /** Short human label shown in the tree. */
  title: string;
  /** Model the worker is pinned to (may differ per worker). */
  modelId: string;
  status: TeamWorkerStatus;
  /** Final report text once the worker finished (or partial on timeout). */
  summary?: string;
};

export type TeamPhase = "planning" | "running" | "synthesizing" | "done";

export type TeamRun = {
  id: string;
  /** Lead session that owns this team. */
  parentSessionId: string;
  goal: string;
  phase: TeamPhase;
  workers: TeamWorker[];
  startedAt: number;
};

type OrchestrationState = {
  /** Keyed by team id. */
  teams: Record<string, TeamRun>;

  startTeam: (input: {
    id: string;
    parentSessionId: string;
    goal: string;
    workers: TeamWorker[];
  }) => void;
  setPhase: (teamId: string, phase: TeamPhase) => void;
  setWorkerStatus: (
    teamId: string,
    sessionId: string,
    status: TeamWorkerStatus,
    summary?: string,
  ) => void;
  removeTeam: (teamId: string) => void;
  getByParent: (parentSessionId: string) => TeamRun | undefined;
  getByWorker: (sessionId: string) => TeamRun | undefined;
};

export const useOrchestrationStore = create<OrchestrationState>((set, get) => ({
  teams: {},

  startTeam: ({ id, parentSessionId, goal, workers }) =>
    set((s) => ({
      teams: {
        ...s.teams,
        [id]: {
          id,
          parentSessionId,
          goal,
          phase: "running",
          workers,
          startedAt: Date.now(),
        },
      },
    })),

  setPhase: (teamId, phase) =>
    set((s) => {
      const t = s.teams[teamId];
      if (!t) return s;
      return { teams: { ...s.teams, [teamId]: { ...t, phase } } };
    }),

  setWorkerStatus: (teamId, sessionId, status, summary) =>
    set((s) => {
      const t = s.teams[teamId];
      if (!t) return s;
      const workers = t.workers.map((w) =>
        w.sessionId === sessionId
          ? { ...w, status, ...(summary !== undefined ? { summary } : {}) }
          : w,
      );
      return { teams: { ...s.teams, [teamId]: { ...t, workers } } };
    }),

  removeTeam: (teamId) =>
    set((s) => {
      if (!s.teams[teamId]) return s;
      const next = { ...s.teams };
      delete next[teamId];
      return { teams: next };
    }),

  getByParent: (parentSessionId) =>
    Object.values(get().teams).find(
      (t) => t.parentSessionId === parentSessionId,
    ),

  getByWorker: (sessionId) =>
    Object.values(get().teams).find((t) =>
      t.workers.some((w) => w.sessionId === sessionId),
    ),
}));
