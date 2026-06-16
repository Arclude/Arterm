import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  ArrowDown01Icon,
  Cancel01Icon,
  Delete02Icon,
  PlusSignIcon,
  SparklesIcon,
  UserMultipleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useChat, type UIMessage } from "@ai-sdk/react";
import { useCallback, useMemo, useState } from "react";
import { getModel, isKnownModelId } from "../config";
import { BUILTIN_AGENTS } from "../lib/agents";
import type { SessionMeta } from "../lib/sessions";
import {
  getOrCreateChat,
  isAgentMetaBusy,
  stopSession,
  useChatStore,
  type AgentMeta,
  type AgentRunStatus,
} from "../store/chatStore";
import { AiChatView } from "./AiChat";
import { AiInputBar } from "./AiInputBar";
import {
  useOrchestrationStore,
  type TeamPhase,
  type TeamRun,
  type TeamWorkerStatus,
} from "../store/orchestrationStore";
import { useAgentsStore } from "../store/agentsStore";
import { AGENT_ICONS } from "./AgentSwitcher";

export type AgentsPanelProps = {
  /** Reveal the conversation surface and focus the composer for a session. */
  onOpenSession: () => void;
};

const STATUS_LABEL: Record<AgentRunStatus, string> = {
  idle: "Idle",
  thinking: "Running",
  streaming: "Running",
  "awaiting-approval": "Needs approval",
  error: "Error",
};

const PHASE_LABEL: Record<TeamPhase, string> = {
  planning: "Planning",
  running: "Running",
  synthesizing: "Synthesizing",
  done: "Done",
};

function statusDotClass(status: AgentRunStatus): string {
  switch (status) {
    case "thinking":
    case "streaming":
      return "bg-emerald-500";
    case "awaiting-approval":
      return "bg-amber-500";
    case "error":
      return "bg-red-500";
    default:
      return "bg-muted-foreground/40";
  }
}

function workerDotClass(status: TeamWorkerStatus): string {
  switch (status) {
    case "running":
      return "bg-emerald-500";
    case "error":
      return "bg-red-500";
    default:
      return "bg-muted-foreground/40";
  }
}

function formatTokens(meta: AgentMeta | undefined): string | null {
  if (!meta) return null;
  const total = meta.tokens.inputTokens + meta.tokens.outputTokens;
  if (total <= 0) return null;
  if (total < 1000) return `${total} tok`;
  return `${(total / 1000).toFixed(total < 10_000 ? 1 : 0)}k tok`;
}

/** Display label for a pinned model id (handles custom/compat ids gracefully). */
function modelLabel(modelId?: string): string | null {
  if (!modelId) return null;
  if (isKnownModelId(modelId)) return getModel(modelId).label;
  return modelId;
}

/** Embedded conversation thread for the active session — keeps the AI in the
 * Agents section instead of a floating window. Input stays in the docked bar. */
function AgentConversation({ sessionId }: { sessionId: string }) {
  const chat = useMemo(() => getOrCreateChat(sessionId), [sessionId]);
  const helpers = useChat<UIMessage>({ chat });

  // Edit a prior user message: drop it and everything after, then resend the
  // new text so the agent re-runs from that point.
  const onEditMessage = useCallback(
    (messageId: string, newText: string) => {
      const idx = chat.messages.findIndex((m) => m.id === messageId);
      if (idx < 0) return;
      chat.messages = chat.messages.slice(0, idx);
      void chat.sendMessage({ text: newText });
    },
    [chat],
  );

  if (helpers.messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-3 text-center text-[11px] text-muted-foreground">
        Type below to talk to this agent.
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden [&_.text-sm]:text-[12px] [&_p]:leading-relaxed">
      <AiChatView
        messages={helpers.messages}
        status={helpers.status}
        error={helpers.error}
        clearError={helpers.clearError}
        addToolApprovalResponse={helpers.addToolApprovalResponse}
        stop={helpers.stop}
        onEditMessage={onEditMessage}
      />
    </div>
  );
}

export function AgentsPanel({ onOpenSession }: AgentsPanelProps) {
  const sessions = useChatStore((s) => s.sessions);
  const metaBySession = useChatStore((s) => s.metaBySession);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const switchSession = useChatStore((s) => s.switchSession);
  const deleteSession = useChatStore((s) => s.deleteSession);
  const newSession = useChatStore((s) => s.newSession);
  const teamMode = useChatStore((s) => s.teamMode);
  const setTeamMode = useChatStore((s) => s.setTeamMode);
  const teams = useOrchestrationStore((s) => s.teams);

  const customAgents = useAgentsStore((s) => s.customAgents);
  const personas = useMemo(
    () => [...BUILTIN_AGENTS, ...customAgents],
    [customAgents],
  );

  // Worker sessions are shown nested under their lead, not as top-level rows.
  const { workerIds, teamByParent } = useMemo(() => {
    const workerIds = new Set<string>();
    const teamByParent = new Map<string, TeamRun>();
    for (const t of Object.values(teams)) {
      teamByParent.set(t.parentSessionId, t);
      for (const w of t.workers) workerIds.add(w.sessionId);
    }
    return { workerIds, teamByParent };
  }, [teams]);

  // Busy agents float to the top; within each bucket keep store order
  // (newest first). Worker sessions are excluded (rendered under their lead).
  const ordered = useMemo(() => {
    const busy: SessionMeta[] = [];
    const rest: SessionMeta[] = [];
    for (const s of sessions) {
      if (workerIds.has(s.id)) continue;
      (isAgentMetaBusy(metaBySession[s.id]) ? busy : rest).push(s);
    }
    return [...busy, ...rest];
  }, [sessions, metaBySession, workerIds]);

  // Active chat + anything still running stays pinned and always visible;
  // only idle past chats live under the collapsible History section.
  const { pinned, rest } = useMemo(() => {
    const pinned: SessionMeta[] = [];
    const rest: SessionMeta[] = [];
    for (const s of ordered) {
      const team = teamByParent.get(s.id);
      const isPinned =
        s.id === activeSessionId ||
        isAgentMetaBusy(metaBySession[s.id]) ||
        (!!team && team.phase !== "done");
      (isPinned ? pinned : rest).push(s);
    }
    return { pinned, rest };
  }, [ordered, metaBySession, teamByParent, activeSessionId]);

  const [historyOpen, setHistoryOpen] = useState(false);

  const startNewChat = () => {
    newSession();
    onOpenSession();
  };

  const renderRow = (s: SessionMeta) => {
    const meta = metaBySession[s.id];
    const status = meta?.status ?? "idle";
    const busy = isAgentMetaBusy(meta);
    const persona = s.agentId ? personas.find((a) => a.id === s.agentId) : null;
    const PersonaIcon = persona
      ? (AGENT_ICONS[persona.icon] ?? SparklesIcon)
      : SparklesIcon;
    const tokens = formatTokens(meta);
    const mLabel = modelLabel(s.modelId);
    const isActive = s.id === activeSessionId;
    const team = teamByParent.get(s.id);
    return (
      <div key={s.id} className="flex flex-col gap-1">
        <div
          role="button"
          tabIndex={0}
          onClick={() => {
            switchSession(s.id);
            onOpenSession();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              switchSession(s.id);
              onOpenSession();
            }
          }}
          className={cn(
            "group flex cursor-pointer flex-col gap-0.5 rounded-md border px-2 py-1.5 text-left outline-none transition-colors",
            "focus-visible:ring-2 focus-visible:ring-primary/40",
            isActive
              ? "border-border bg-foreground/[0.06]"
              : "border-transparent hover:border-border/60 hover:bg-foreground/[0.035]",
          )}
        >
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                statusDotClass(status),
              )}
            />
            <span className="min-w-0 flex-1 truncate text-xs text-foreground">
              {s.title}
            </span>
            {team ? (
              <span className="shrink-0 rounded bg-foreground/[0.08] px-1 text-[9.5px] uppercase tracking-wide text-muted-foreground">
                team · {PHASE_LABEL[team.phase]}
              </span>
            ) : null}
            {busy ? (
              <Button
                size="xs"
                variant="ghost"
                title="Stop agent"
                className="h-5 w-5 shrink-0 p-0 opacity-0 transition-opacity group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  stopSession(s.id);
                }}
              >
                <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
              </Button>
            ) : (
              <Button
                size="xs"
                variant="ghost"
                title="Delete session"
                className="h-5 w-5 shrink-0 p-0 opacity-0 transition-opacity group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteSession(s.id);
                }}
              >
                <HugeiconsIcon icon={Delete02Icon} size={11} strokeWidth={2} />
              </Button>
            )}
          </div>
          <div className="flex items-center gap-1.5 pl-3 text-[10.5px] text-muted-foreground">
            {busy ? <Spinner className="size-2.5" /> : null}
            <span
              className={cn(
                status === "error" && "text-red-500",
                status === "awaiting-approval" && "text-amber-500",
              )}
            >
              {STATUS_LABEL[status]}
              {status === "awaiting-approval" &&
              meta &&
              meta.approvalsPending > 1
                ? ` (${meta.approvalsPending})`
                : ""}
            </span>
            {busy && meta?.step ? (
              <span className="min-w-0 flex-1 truncate">· {meta.step}</span>
            ) : null}
            {mLabel ? (
              <span className="shrink-0 truncate text-muted-foreground/80">
                · {mLabel}
              </span>
            ) : null}
            {persona ? (
              <span className="ml-auto flex shrink-0 items-center gap-1">
                <HugeiconsIcon
                  icon={PersonaIcon}
                  size={10}
                  strokeWidth={1.75}
                />
                {persona.name}
              </span>
            ) : null}
            {tokens ? (
              <span className="shrink-0 tabular-nums">{tokens}</span>
            ) : null}
          </div>
        </div>

        {team ? (
          <div className="ml-3 flex flex-col gap-0.5 border-l border-border/50 pl-2">
            {team.workers.map((w) => {
              const wMeta = metaBySession[w.sessionId];
              const wActive = w.sessionId === activeSessionId;
              return (
                <div
                  key={w.sessionId}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    switchSession(w.sessionId);
                    onOpenSession();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      switchSession(w.sessionId);
                      onOpenSession();
                    }
                  }}
                  className={cn(
                    "flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-left outline-none transition-colors",
                    "focus-visible:ring-2 focus-visible:ring-primary/40",
                    wActive
                      ? "bg-foreground/[0.06]"
                      : "hover:bg-foreground/[0.035]",
                  )}
                >
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      workerDotClass(w.status),
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/90">
                    {w.title}
                  </span>
                  {w.status === "running" && wMeta?.step ? (
                    <span className="hidden min-w-0 shrink truncate text-[10px] text-muted-foreground sm:block">
                      {wMeta.step}
                    </span>
                  ) : null}
                  <span className="shrink-0 text-[9.5px] text-muted-foreground/80">
                    {modelLabel(w.modelId)}
                  </span>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Agents
        </span>
        <div className="flex items-center gap-1.5">
          <Button
            size="xs"
            variant={teamMode ? "default" : "outline"}
            title="Team mode — let the AI fan work out to multiple worker agents"
            className="h-6 gap-1 px-1.5 text-[10.5px]"
            onClick={() => setTeamMode(!teamMode)}
          >
            <HugeiconsIcon icon={UserMultipleIcon} size={12} strokeWidth={2} />
            Team
          </Button>
          <Button
            size="xs"
            variant="outline"
            title="Start a new chat"
            className="h-6 gap-1 px-1.5 text-[10.5px]"
            onClick={startNewChat}
          >
            <HugeiconsIcon icon={PlusSignIcon} size={12} strokeWidth={2} />
            New chat
          </Button>
        </div>
      </div>

      {/* Active + running agents — always visible. */}
      {pinned.length > 0 ? (
        <div className="max-h-[40%] min-h-0 shrink-0 overflow-y-auto px-2 pt-1 pb-1">
          <div className="flex flex-col gap-1">{pinned.map(renderRow)}</div>
        </div>
      ) : null}

      {/* History — collapsible; only idle past chats. */}
      <button
        type="button"
        onClick={() => setHistoryOpen((v) => !v)}
        className="flex items-center gap-1 px-3 pt-1 pb-0.5 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70 outline-none transition-colors hover:text-muted-foreground"
      >
        <span
          className={cn(
            "transition-transform",
            historyOpen ? "" : "-rotate-90",
          )}
        >
          <HugeiconsIcon icon={ArrowDown01Icon} size={12} strokeWidth={2} />
        </span>
        History
        {rest.length > 0 ? (
          <span className="text-muted-foreground/50">({rest.length})</span>
        ) : null}
      </button>

      {historyOpen ? (
        <div className="max-h-[35%] min-h-0 shrink-0 overflow-y-auto px-2 pb-2">
          {rest.length === 0 ? (
            <div className="px-2 py-4 text-center text-[11px] text-muted-foreground">
              No past chats.
            </div>
          ) : (
            <div className="flex flex-col gap-1">{rest.map(renderRow)}</div>
          )}
        </div>
      ) : null}

      {activeSessionId ? (
        <div className="flex min-h-0 flex-1 flex-col border-t border-border/60">
          <AgentConversation
            key={activeSessionId}
            sessionId={activeSessionId}
          />
          <AiInputBar />
        </div>
      ) : null}
    </div>
  );
}
