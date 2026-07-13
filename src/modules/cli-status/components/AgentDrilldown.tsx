import { compact, type DerivedAgent, fmtElapsed } from "../lib/dashboard";
import { AgentStatePill, agentDotVariant, StatusDot } from "./CliAtoms";

function BigNum({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-card/60 px-2.5 py-2">
      <div className="cli-mono text-[8.5px] uppercase tracking-[0.13em] text-muted-foreground/80">
        {k}
      </div>
      <div className="cli-mono text-[18px] font-bold text-foreground">{v}</div>
    </div>
  );
}

export function AgentDrilldown({
  agent,
  now,
}: {
  agent: DerivedAgent;
  now: number;
}) {
  const elapsed =
    agent.startedAt != null
      ? fmtElapsed(Math.max(0, Math.floor((now - agent.startedAt) / 1000)))
      : "—";
  const recent = [...agent.recentActivities].reverse();

  return (
    <div>
      <div className="flex items-center gap-2">
        <StatusDot variant={agentDotVariant(agent.state)} />
        <span
          className="cli-mono truncate text-[15px] font-bold"
          style={{ color: agent.colorVar }}
        >
          {agent.name}
        </span>
        <AgentStatePill state={agent.state} className="ml-auto shrink-0" />
      </div>

      <div
        className="cli-mono mt-2 rounded-lg bg-card/70 px-2.5 py-2 text-[12px] text-muted-foreground"
        style={{ borderLeft: "3px solid var(--cli-accent)" }}
      >
        {agent.activity || "—"}
      </div>

      <div className="mt-2.5 grid grid-cols-2 gap-2">
        <BigNum k="Tokens" v={compact(agent.tokenCount)} />
        <BigNum
          k="Tool uses"
          v={agent.toolUseCount != null ? String(agent.toolUseCount) : "—"}
        />
        <BigNum k="Elapsed" v={elapsed} />
        <BigNum
          k="Files"
          v={agent.filesChanged != null ? String(agent.filesChanged) : "—"}
        />
      </div>

      <div className="mt-3">
        <div className="cli-mono mb-1.5 text-[9px] uppercase tracking-[0.13em] text-muted-foreground/80">
          Recent activity
        </div>
        {recent.length === 0 ? (
          <div className="cli-mono text-[11px] text-muted-foreground/60">
            no recent activity
          </div>
        ) : (
          <ul className="flex flex-col gap-1">
            {recent.map((r, i) => (
              <li
                key={`${recent.length - i}-${r}`}
                className="cli-mono flex items-baseline gap-2 text-[11px] text-muted-foreground"
              >
                <span className="w-3.5 shrink-0 text-right text-muted-foreground/60">
                  {recent.length - i}
                </span>
                <span className="min-w-0 flex-1 truncate">{r}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
