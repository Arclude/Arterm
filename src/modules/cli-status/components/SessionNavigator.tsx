import { cn } from "@/lib/utils";
import { agentCounts, basename, deriveAgents } from "../lib/dashboard";
import type { CliSessionEntry } from "../store/cliStatusStore";
import { StatusDot, sessionDotVariant } from "./CliAtoms";

export function SessionNavigator({
  entries,
  selectedId,
  onSelect,
}: {
  entries: CliSessionEntry[];
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1 px-2 pb-2">
      {entries.map((entry) => {
        const { info, snapshot } = entry;
        const agents = snapshot ? deriveAgents(snapshot) : [];
        const counts = snapshot ? agentCounts(snapshot) : null;
        const model = snapshot?.model ?? info.model ?? "";
        const provider = snapshot?.provider ?? info.provider ?? "";
        const selected = info.sessionId === selectedId;
        const lost = entry.connection === "lost";
        return (
          <button
            type="button"
            key={info.sessionId}
            onClick={() => onSelect(info.sessionId)}
            className={cn(
              "grid grid-cols-[auto_1fr] items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left outline-none transition-colors",
              "focus-visible:ring-2 focus-visible:ring-[color:var(--cli-accent)]/40",
              selected
                ? "border-[color:var(--cli-accent)]/45 bg-card"
                : "border-transparent hover:bg-card/70",
              lost && "opacity-60",
            )}
          >
            <StatusDot variant={sessionDotVariant(entry)} />
            <div className="min-w-0">
              <div
                className="cli-mono truncate text-[12.5px] font-semibold text-foreground"
                title={info.cwd}
              >
                {basename(info.cwd)}
              </div>
              <div className="cli-mono truncate text-[10px] text-muted-foreground/80">
                {model}
                {provider ? ` · ${provider}` : ""}
                {info.terminalId != null ? ` · tab ${info.terminalId}` : ""}
              </div>
              <div className="cli-mono mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <span className="inline-flex gap-[3px]">
                  {agents.map((a) => (
                    <span
                      key={a.id}
                      className="inline-block size-1.5 rounded-full"
                      style={{
                        background: a.colorVar,
                        opacity: a.state === "done" ? 0.45 : 1,
                      }}
                    />
                  ))}
                </span>
                {lost ? (
                  <span className="text-[color:var(--cli-lost)]">
                    connection lost
                  </span>
                ) : counts ? (
                  <span>
                    {counts.running} running · {counts.total} agent
                    {counts.total === 1 ? "" : "s"}
                  </span>
                ) : (
                  <span>connecting…</span>
                )}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
