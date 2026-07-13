import { cn } from "@/lib/utils";
import {
  compact,
  type DerivedAgent,
  fmtElapsed,
  IDLE_MS,
  isActiveAgent,
} from "../lib/dashboard";
import { AgentStatePill } from "./CliAtoms";

type Props = {
  agent: DerivedAgent;
  gauge: number;
  selected: boolean;
  now: number;
  onSelect: () => void;
};

export function AgentCard({ agent, gauge, selected, now, onSelect }: Props) {
  const elapsed =
    agent.startedAt != null
      ? Math.max(0, Math.floor((now - agent.startedAt) / 1000))
      : null;
  const idle =
    agent.lastActivityAt != null && now - agent.lastActivityAt > IDLE_MS;
  const showCaret = isActiveAgent(agent) && !idle;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "relative w-full rounded-xl border bg-card/60 px-3 py-2.5 text-left outline-none transition-colors",
        "focus-visible:ring-2 focus-visible:ring-[color:var(--cli-accent)]/50",
        selected
          ? "border-[color:var(--cli-accent)] shadow-[inset_0_0_0_1px_var(--cli-accent)]"
          : "border-border hover:border-[color:var(--cli-accent)]/50",
      )}
    >
      <span className="cli-idbar" style={{ background: agent.colorVar }} />
      <div className="flex items-center gap-2 pl-1.5">
        <span
          className="cli-mono truncate text-[13px] font-bold"
          style={{ color: agent.colorVar }}
        >
          {agent.name}
          {agent.adhoc ? (
            <span className="text-muted-foreground/70" title="ad-hoc member">
              *
            </span>
          ) : null}
        </span>
        <AgentStatePill state={agent.state} className="ml-auto shrink-0" />
      </div>

      <div className="cli-mono mt-1.5 flex items-center gap-1.5 pl-1.5 text-[11px] text-muted-foreground">
        <span style={{ color: "var(--cli-accent)" }}>{agent.glyph}</span>
        <span className="min-w-0 flex-1 truncate">{agent.activity || "—"}</span>
        {showCaret ? <span className="cli-caret">▍</span> : null}
      </div>

      <div className="cli-meter mt-2 ml-1.5">
        <span style={{ width: `${gauge}%`, background: agent.colorVar }} />
      </div>

      <div className="cli-mono mt-1.5 ml-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
        {agent.toolUseCount != null ? (
          <span>
            <b className="font-semibold text-foreground/80">
              {agent.toolUseCount}
            </b>{" "}
            tools
          </span>
        ) : null}
        <span>{compact(agent.tokenCount)} tok</span>
        {elapsed != null ? <span>{fmtElapsed(elapsed)}</span> : null}
        {agent.filesChanged ? (
          <span style={{ color: "var(--cli-accent)" }}>
            <b className="font-semibold">{agent.filesChanged}</b> files
          </span>
        ) : null}
        {idle ? (
          <span className="text-[color:var(--cli-idle)]">idle</span>
        ) : null}
      </div>
    </button>
  );
}
