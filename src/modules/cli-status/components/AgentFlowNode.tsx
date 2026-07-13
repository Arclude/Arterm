import { Handle, type NodeProps, Position } from "@xyflow/react";
import { cn } from "@/lib/utils";
import { agentCounts, basename, compact } from "../lib/dashboard";
import type { TopoNode } from "../lib/topology";
import {
  AgentStatePill,
  agentDotVariant,
  StatusDot,
  sessionDotVariant,
} from "./CliAtoms";

const KIND_LABEL: Record<TopoNode["kind"], string> = {
  session: "session",
  main: "coordinator",
  member: "member",
  worker: "worker",
};

/** Both handles, visually hidden — edges attach here; nodes aren't user-connectable. */
function Handles() {
  return (
    <>
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        style={{ opacity: 0, width: 1, height: 1, border: "none" }}
      />
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        style={{ opacity: 0, width: 1, height: 1, border: "none" }}
      />
    </>
  );
}

/**
 * A React-Flow node in the dashboard visual language. Renders either a session
 * root (global view — label / model·provider / running·total) or an agent
 * (coordinator / member / worker with its telemetry chips), branching on the
 * TopoNode kind. Reuses the same cli-dash palette, status dots, and chip idiom
 * as `AgentCard` so the graph reads as native.
 */
export function AgentFlowNode({ data, selected }: NodeProps) {
  const node = data as unknown as TopoNode;

  if (node.kind === "session" && node.entry) {
    const entry = node.entry;
    const snap = entry.snapshot;
    const counts = snap ? agentCounts(snap) : { running: 0, total: 1 };
    const model = snap?.model ?? entry.info.model ?? "";
    const provider = snap?.provider ?? entry.info.provider ?? "";
    return (
      <div
        className={cn(
          "relative w-[196px] rounded-[10px] border bg-card/80 px-3 py-2 pl-3.5 text-left shadow-sm transition-colors",
          selected ? "border-transparent" : "border-border",
        )}
        style={
          selected
            ? { boxShadow: "inset 0 0 0 1px var(--cli-accent)" }
            : undefined
        }
      >
        <Handles />
        <span
          className="absolute top-2 bottom-2 left-0 w-[3px] rounded"
          style={{ background: "var(--cli-accent)" }}
        />
        <div className="flex items-center gap-1.5">
          <StatusDot variant={sessionDotVariant(entry)} />
          <span
            className="cli-mono truncate text-[12px] font-bold"
            style={{ color: "var(--cli-accent)" }}
            title={entry.info.cwd}
          >
            {basename(entry.info.cwd)}
          </span>
          <span className="cli-mono text-[8px] uppercase tracking-[0.1em] text-muted-foreground/60">
            session
          </span>
          <span className="cli-mono ml-auto shrink-0 text-[9.5px] tabular-nums text-muted-foreground">
            {counts.running}/{counts.total}
          </span>
        </div>
        <div className="cli-mono mt-1 truncate text-[10.5px] text-muted-foreground/85">
          {model}
          {provider ? ` · ${provider}` : ""}
        </div>
      </div>
    );
  }

  const agent = node.agent;
  if (!agent) return null;
  return (
    <div
      className={cn(
        "relative w-[196px] rounded-[10px] border bg-card/70 px-3 py-2 pl-3.5 text-left shadow-sm transition-colors",
        selected ? "border-transparent" : "border-border",
      )}
      style={
        selected
          ? { boxShadow: `inset 0 0 0 1px ${agent.colorVar}` }
          : undefined
      }
    >
      <Handles />
      <span
        className="absolute top-2 bottom-2 left-0 w-[3px] rounded"
        style={{ background: agent.colorVar }}
      />

      <div className="flex items-center gap-1.5">
        <StatusDot variant={agentDotVariant(agent.state)} />
        <span
          className="cli-mono truncate text-[12px] font-bold"
          style={{ color: agent.colorVar }}
        >
          {agent.name}
          {agent.adhoc ? (
            <span className="text-muted-foreground/70" title="ad-hoc member">
              *
            </span>
          ) : null}
        </span>
        <span className="cli-mono text-[8px] uppercase tracking-[0.1em] text-muted-foreground/60">
          {KIND_LABEL[agent.kind]}
        </span>
        <AgentStatePill state={agent.state} className="ml-auto shrink-0" />
      </div>

      <div className="cli-mono mt-1 flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
        <span style={{ color: "var(--cli-accent)" }}>{agent.glyph}</span>
        <span className="min-w-0 flex-1 truncate">{agent.activity || "—"}</span>
      </div>

      <div className="cli-mono mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[9.5px] text-muted-foreground/80">
        {agent.toolUseCount != null ? (
          <span>
            <b className="font-semibold text-foreground/80">
              {agent.toolUseCount}
            </b>{" "}
            tools
          </span>
        ) : null}
        <span>{compact(agent.tokenCount)} tok</span>
        {agent.filesChanged ? (
          <span style={{ color: "var(--cli-accent)" }}>
            <b className="font-semibold">{agent.filesChanged}</b> files
          </span>
        ) : null}
      </div>
    </div>
  );
}
