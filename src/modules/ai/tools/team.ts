import { tool } from "ai";
import { z } from "zod";
import {
  getChat,
  hasKeyForModel,
  spawnAgentSession,
  stopSession,
  useChatStore,
  type AgentRunStatus,
} from "../store/chatStore";
import { useOrchestrationStore } from "../store/orchestrationStore";
import { isCompatModelId, isKnownModelId } from "../config";
import type { ToolContext } from "./context";

/** Hard cap on parallel workers a single team may spawn. */
const MAX_WORKERS = 5;
/** Per-worker wall-clock budget before it is force-stopped. */
const WORKER_TIMEOUT_MS = 5 * 60_000;
/** Grace period for a freshly spawned worker to start streaming. */
const STARTUP_GRACE_MS = 12_000;
const POLL_MS = 600;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Read-only mandate prepended to every worker prompt. Workers run with the full
 * tool set, but in this first version a team is an investigation fan-out — the
 * lead does the actual writing after synthesis. We additionally auto-reject any
 * mutation approval below, so this is enforced, not just advisory.
 */
function workerPrompt(goal: string, title: string, body: string): string {
  return `You are ONE worker in a coordinated agent team. The team's overall goal is:
${goal}

Your assignment: ${title}
${body}

RULES:
- Investigate and REPORT ONLY. Do NOT modify, create, or delete files; do NOT run mutating shell commands. Any such attempt will be auto-rejected.
- You have no memory of the lead's conversation — rely only on what's written here plus your own reads.
- End with a concise, self-contained findings report. It will be merged with other workers' reports by the lead.`;
}

/** Concatenate the text of the most recent assistant message in a session. */
function readLastReport(sessionId: string): string {
  const chat = getChat(sessionId);
  if (!chat) return "";
  const msgs = chat.messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "assistant") continue;
    const text = m.parts
      .filter((p) => (p as { type?: string }).type === "text")
      .map((p) => (p as { text?: string }).text ?? "")
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

/** Reject any pending mutation approval so a read-only worker never deadlocks. */
function rejectPendingApprovals(sessionId: string): void {
  const chat = getChat(sessionId);
  if (!chat) return;
  const respond = useChatStore.getState().respondToApproval;
  for (const m of chat.messages) {
    if (m.role !== "assistant") continue;
    for (const p of m.parts as {
      state?: string;
      approval?: { id?: string };
    }[]) {
      if (p.state === "approval-requested" && p.approval?.id) {
        respond(p.approval.id, false, sessionId);
      }
    }
  }
}

function statusOf(sessionId: string): AgentRunStatus {
  return useChatStore.getState().metaBySession[sessionId]?.status ?? "idle";
}

export function buildTeamTools(ctx: ToolContext) {
  return {
    run_agent_team: tool({
      description: `Run a synchronized team of background worker agents to investigate a goal in parallel, then collect their reports for you to synthesize. Use for multi-part, parallelizable work where independent angles can progress at once (e.g. "audit security AND performance AND test coverage", or "research three candidate libraries"). Each worker is an isolated read-only session that can use a DIFFERENT model (pass modelId per subtask, e.g. a local Ollama model for one and a cloud model for another).

Workers investigate and report only — YOU (the lead) perform any file changes afterward, using the synthesized findings. The tool blocks until all workers finish (or time out) and returns their reports.

Requires user approval before spawning. Provide 2–${MAX_WORKERS} focused, non-overlapping subtasks.`,
      inputSchema: z.object({
        goal: z
          .string()
          .describe("One-line statement of the overall objective."),
        subtasks: z
          .array(
            z.object({
              title: z
                .string()
                .describe("Short label for this worker's assignment."),
              prompt: z
                .string()
                .describe(
                  "Self-contained instruction for the worker. Include all needed context — the worker cannot see your conversation.",
                ),
              modelId: z
                .string()
                .optional()
                .describe(
                  "Optional model id to pin this worker to. Defaults to the current model.",
                ),
            }),
          )
          .min(2)
          .max(MAX_WORKERS),
      }),
      needsApproval: true,
      execute: async ({ goal, subtasks }, { abortSignal }) => {
        const parentSessionId = ctx.getSessionId() ?? "";
        const orch = useOrchestrationStore.getState();

        // Workers are read-only and must not spawn nested teams.
        if (parentSessionId && orch.getByWorker(parentSessionId)) {
          return {
            error:
              "you are a team worker — investigate and report only; do not spawn a nested team",
          };
        }

        // Spawn one background worker per subtask. They start streaming
        // immediately and run concurrently.
        const spawned: {
          sessionId: string;
          title: string;
          modelId: string;
        }[] = [];
        const skipped: { title: string; reason: string }[] = [];
        const defaultModel = useChatStore.getState().selectedModelId;

        for (const st of subtasks) {
          // Models can hallucinate a modelId (e.g. "sonnet"). Only honor a real
          // known/compat id; otherwise fall back to the lead's model.
          const requested = st.modelId;
          const modelId =
            requested &&
            (isKnownModelId(requested) || isCompatModelId(requested))
              ? requested
              : defaultModel;
          if (!hasKeyForModel(modelId)) {
            skipped.push({
              title: st.title,
              reason: `no API key for model "${modelId}"`,
            });
            continue;
          }
          const sessionId = spawnAgentSession({
            prompt: workerPrompt(goal, st.title, st.prompt),
            modelId,
            activate: false,
          });
          if (!sessionId) {
            skipped.push({ title: st.title, reason: "spawn failed" });
            continue;
          }
          spawned.push({ sessionId, title: st.title, modelId });
        }

        if (spawned.length === 0) {
          return {
            error: "no workers could be spawned",
            skipped,
          };
        }

        const teamId =
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `team-${Date.now()}`;
        orch.startTeam({
          id: teamId,
          parentSessionId,
          goal,
          workers: spawned.map((w) => ({
            sessionId: w.sessionId,
            title: w.title,
            modelId: w.modelId,
            status: "running",
          })),
        });

        // Poll each worker until it goes idle/error (after having started), or
        // until its budget runs out. Auto-reject any mutation approval so a
        // read-only worker never blocks the team.
        const pending = new Set(spawned.map((w) => w.sessionId));
        const started = new Set<string>();
        const startedAt = Date.now();

        while (pending.size > 0) {
          if (abortSignal?.aborted) {
            for (const id of pending) stopSession(id);
            break;
          }
          await sleep(POLL_MS);
          const elapsed = Date.now() - startedAt;
          for (const id of Array.from(pending)) {
            const status = statusOf(id);
            if (
              status === "thinking" ||
              status === "streaming" ||
              status === "awaiting-approval"
            ) {
              started.add(id);
            }
            if (status === "awaiting-approval") {
              rejectPendingApprovals(id);
              continue;
            }
            const finished =
              status === "error" ||
              (started.has(id) && status === "idle") ||
              // Never started after the grace window — treat as finished.
              (!started.has(id) &&
                status === "idle" &&
                elapsed > STARTUP_GRACE_MS);
            const timedOut = elapsed > WORKER_TIMEOUT_MS;
            if (finished || timedOut) {
              if (timedOut && !finished) stopSession(id);
              pending.delete(id);
              const summary =
                readLastReport(id) ||
                (timedOut ? "(timed out before reporting)" : "(no output)");
              orch.setWorkerStatus(
                teamId,
                id,
                status === "error" ? "error" : "done",
                summary,
              );
            }
          }
        }

        orch.setPhase(teamId, "done");

        const reports = spawned.map((w) => {
          const worker = useOrchestrationStore
            .getState()
            .teams[teamId]?.workers.find((x) => x.sessionId === w.sessionId);
          return {
            title: w.title,
            model: w.modelId,
            status: worker?.status ?? "done",
            report:
              worker?.summary ?? (readLastReport(w.sessionId) || "(no output)"),
          };
        });

        return {
          goal,
          workers: reports,
          ...(skipped.length > 0 ? { skipped } : {}),
          note: "Synthesize these worker reports into a single answer for the user. You (the lead) are responsible for any file changes that follow.",
        };
      },
    }),
  } as const;
}
