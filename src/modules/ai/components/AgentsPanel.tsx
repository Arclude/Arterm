import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  Cancel01Icon,
  Delete02Icon,
  PlusSignIcon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo, useState } from "react";
import { BUILTIN_AGENTS } from "../lib/agents";
import {
  isAgentMetaBusy,
  spawnAgentSession,
  stopSession,
  useChatStore,
  type AgentMeta,
  type AgentRunStatus,
} from "../store/chatStore";
import { useAgentsStore } from "../store/agentsStore";
import { AGENT_ICONS } from "./AgentSwitcher";

export type AgentsPanelProps = {
  /** Bring the conversation surface (mini window) up for a session. */
  onOpenSession: () => void;
};

const STATUS_LABEL: Record<AgentRunStatus, string> = {
  idle: "Idle",
  thinking: "Running",
  streaming: "Running",
  "awaiting-approval": "Needs approval",
  error: "Error",
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

function formatTokens(meta: AgentMeta | undefined): string | null {
  if (!meta) return null;
  const total = meta.tokens.inputTokens + meta.tokens.outputTokens;
  if (total <= 0) return null;
  if (total < 1000) return `${total} tok`;
  return `${(total / 1000).toFixed(total < 10_000 ? 1 : 0)}k tok`;
}

export function AgentsPanel({ onOpenSession }: AgentsPanelProps) {
  const sessions = useChatStore((s) => s.sessions);
  const metaBySession = useChatStore((s) => s.metaBySession);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const switchSession = useChatStore((s) => s.switchSession);
  const deleteSession = useChatStore((s) => s.deleteSession);

  const customAgents = useAgentsStore((s) => s.customAgents);
  const personas = useMemo(
    () => [...BUILTIN_AGENTS, ...customAgents],
    [customAgents],
  );

  const [composerOpen, setComposerOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [personaId, setPersonaId] = useState<string>(BUILTIN_AGENTS[0].id);
  const [spawnError, setSpawnError] = useState<string | null>(null);

  // Busy agents float to the top; within each bucket keep store order
  // (newest first).
  const ordered = useMemo(() => {
    const busy: typeof sessions = [];
    const rest: typeof sessions = [];
    for (const s of sessions) {
      (isAgentMetaBusy(metaBySession[s.id]) ? busy : rest).push(s);
    }
    return [...busy, ...rest];
  }, [sessions, metaBySession]);

  const startAgent = () => {
    const text = prompt.trim();
    if (!text) return;
    const id = spawnAgentSession({ prompt: text, agentId: personaId });
    if (!id) {
      setSpawnError("No API key for the selected model.");
      return;
    }
    setSpawnError(null);
    setPrompt("");
    setComposerOpen(false);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Agents
        </span>
        <Button
          size="xs"
          variant="outline"
          className="h-6 gap-1 px-1.5 text-[10.5px]"
          onClick={() => setComposerOpen((v) => !v)}
        >
          <HugeiconsIcon icon={PlusSignIcon} size={12} strokeWidth={2} />
          New Agent
        </Button>
      </div>

      {composerOpen ? (
        <div className="mx-2 mb-2 flex flex-col gap-2 rounded-md border border-border/60 bg-card/60 p-2">
          <Select value={personaId} onValueChange={setPersonaId}>
            <SelectTrigger className="h-7 w-full text-xs">
              <SelectValue placeholder="Persona" />
            </SelectTrigger>
            <SelectContent>
              {personas.map((a) => (
                <SelectItem key={a.id} value={a.id} className="text-xs">
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                startAgent();
              }
            }}
            placeholder="Describe the task… (Ctrl+Enter to start)"
            className="min-h-16 resize-none text-xs"
          />
          {spawnError ? (
            <div className="text-[11px] text-destructive">{spawnError}</div>
          ) : null}
          <div className="flex justify-end gap-1.5">
            <Button
              size="xs"
              variant="ghost"
              className="h-6 px-2 text-[10.5px]"
              onClick={() => {
                setComposerOpen(false);
                setSpawnError(null);
              }}
            >
              Cancel
            </Button>
            <Button
              size="xs"
              className="h-6 px-2 text-[10.5px]"
              disabled={!prompt.trim()}
              onClick={startAgent}
            >
              Start
            </Button>
          </div>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {ordered.length === 0 ? (
          <div className="px-2 py-6 text-center text-[11px] text-muted-foreground">
            No agent sessions yet. Start one with “New Agent”.
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {ordered.map((s) => {
              const meta = metaBySession[s.id];
              const status = meta?.status ?? "idle";
              const busy = isAgentMetaBusy(meta);
              const persona = s.agentId
                ? personas.find((a) => a.id === s.agentId)
                : null;
              const PersonaIcon = persona
                ? (AGENT_ICONS[persona.icon] ?? SparklesIcon)
                : SparklesIcon;
              const tokens = formatTokens(meta);
              const isActive = s.id === activeSessionId;
              return (
                <div
                  key={s.id}
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
                        <HugeiconsIcon
                          icon={Cancel01Icon}
                          size={11}
                          strokeWidth={2}
                        />
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
                        <HugeiconsIcon
                          icon={Delete02Icon}
                          size={11}
                          strokeWidth={2}
                        />
                      </Button>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 pl-3 text-[10.5px] text-muted-foreground">
                    {status === "thinking" || status === "streaming" ? (
                      <Spinner className="size-2.5" />
                    ) : null}
                    <span
                      className={cn(
                        status === "error" && "text-destructive",
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
                      <span className="min-w-0 flex-1 truncate">
                        · {meta.step}
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
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
