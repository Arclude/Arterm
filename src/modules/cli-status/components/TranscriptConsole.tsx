import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { DerivedAgent } from "../lib/dashboard";
import {
  buildTranscript,
  type TranscriptTool,
  type TranscriptTurn,
} from "../lib/transcript";
import type { StampedEvent } from "../types";

type Who = { name: string; colorVar: string };

function fmtTime(ts: number): string {
  return new Date(ts).toTimeString().slice(0, 8);
}

/** Red/green diff renderer for a tool_result `diff: DiffRow[]`
 *  (`{kind: "context"|"add"|"del"|"hunk", old?, new?, text}`). Renders only when
 *  the payload is a non-empty array; the ToolCard falls back to plain output. */
function DiffBlock({ diff, path }: { diff: unknown; path?: string }) {
  if (!Array.isArray(diff) || diff.length === 0) return null;
  return (
    <div className="mt-1 overflow-x-auto rounded-md border border-border/50 bg-background/40">
      {path ? (
        <div className="cli-mono border-b border-border/40 px-2 py-0.5 text-[9.5px] text-muted-foreground/70">
          {path}
        </div>
      ) : null}
      {diff.map((raw, i) => {
        const l = (raw && typeof raw === "object" ? raw : {}) as Record<
          string,
          unknown
        >;
        const kind = String(l.kind ?? "context").toLowerCase();
        const text = String(l.text ?? "");
        if (kind === "hunk") {
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional
              key={i}
              className="cli-mono whitespace-pre px-2 text-[10px] leading-[1.5] text-[color:var(--cli-accent)]"
              style={{ background: "var(--cli-accent-ghost)" }}
            >
              {text}
            </div>
          );
        }
        const add = kind === "add";
        const del = kind === "del";
        const gutter =
          typeof l.new === "number"
            ? String(l.new)
            : typeof l.old === "number"
              ? String(l.old)
              : "";
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional
            key={i}
            className="cli-mono flex whitespace-pre text-[10.5px] leading-[1.5]"
            style={{
              color: add
                ? "var(--cli-run)"
                : del
                  ? "var(--cli-fail)"
                  : "var(--cli-idle)",
              background: add
                ? "color-mix(in oklab, var(--cli-run) 12%, transparent)"
                : del
                  ? "color-mix(in oklab, var(--cli-fail) 12%, transparent)"
                  : "transparent",
            }}
          >
            <span className="w-8 shrink-0 select-none pr-2 text-right text-muted-foreground/40">
              {gutter}
            </span>
            <span className="pr-2">
              {add ? "+" : del ? "-" : " "} {text}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ToolCard({ tool }: { tool: TranscriptTool }) {
  const [open, setOpen] = useState(false);
  const hasDiff = Array.isArray(tool.diff) && tool.diff.length > 0;
  const hasBody = hasDiff || (tool.output != null && tool.output !== "");
  const glyph = tool.denied ? "⊘" : tool.isError ? "✘" : "⚙";
  const color = tool.denied
    ? "var(--cli-await)"
    : tool.isError
      ? "var(--cli-fail)"
      : "var(--cli-accent)";
  return (
    <div
      className={cn(
        "rounded-md border bg-card/40",
        tool.isError ? "border-[color:var(--cli-fail)]/45" : "border-border/50",
      )}
    >
      <button
        type="button"
        onClick={() => hasBody && setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-1.5 px-2 py-1 text-left outline-none",
          hasBody && "hover:bg-foreground/[0.03]",
        )}
      >
        <span style={{ color }}>{glyph}</span>
        <span className="cli-mono shrink-0 text-[11px] font-semibold text-foreground/85">
          {tool.name}
        </span>
        {tool.args ? (
          <span className="cli-mono min-w-0 flex-1 truncate text-[10.5px] text-muted-foreground/80">
            {tool.args}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {tool.denied ? (
          <span className="cli-mono text-[9px] text-[color:var(--cli-await)]">
            denied
          </span>
        ) : hasBody ? (
          <span className="cli-mono text-[9px] text-muted-foreground/60">
            {open ? "▲" : "▼"}
          </span>
        ) : null}
      </button>
      {open && hasBody ? (
        <div className="border-t border-border/40 px-2 py-1">
          {hasDiff ? (
            <DiffBlock diff={tool.diff} path={tool.path} />
          ) : (
            <pre className="cli-mono max-h-64 overflow-auto whitespace-pre-wrap break-words text-[10.5px] leading-[1.5] text-muted-foreground">
              {tool.output}
            </pre>
          )}
        </div>
      ) : null}
    </div>
  );
}

function TurnBlock({ turn, who }: { turn: TranscriptTurn; who: Who }) {
  return (
    <div className="border-b border-border/30 px-3 py-2 last:border-b-0">
      <div className="flex items-center gap-1.5">
        <span
          className="inline-block size-1.5 shrink-0 rounded-full"
          style={{ background: who.colorVar }}
        />
        <span
          className="cli-mono text-[10.5px] font-bold"
          style={{ color: who.colorVar }}
        >
          {who.name}
        </span>
        <span className="cli-mono ml-auto text-[9px] text-muted-foreground/50">
          {fmtTime(turn.ts)}
        </span>
      </div>
      {turn.text ? (
        <p className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-foreground/90">
          {turn.text}
        </p>
      ) : null}
      {turn.tools.length > 0 ? (
        <div className="mt-1.5 flex flex-col gap-1">
          {turn.tools.map((t) => (
            <ToolCard key={`${t.seq}-${t.name}`} tool={t} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Live per-session console: reads the focused session's rolling event feed and
 * renders it as turns (assistant text + collapsible tool cards with output/diff).
 * Auto-sticks to the bottom while live unless the user scrolls up. The feed is a
 * capped window (200), so this is a live tail, not full history.
 */
export function TranscriptConsole({
  feed,
  agents,
}: {
  feed: StampedEvent[];
  agents: DerivedAgent[];
}) {
  const turns = useMemo(() => buildTranscript(feed), [feed]);

  const whoOf = useMemo(() => {
    // Resolve a turn's author (id "main" or a member id) to a name + color from
    // the roster; unknown ids (e.g. a finished member) fall back to a neutral dot.
    const byId = new Map(agents.map((a) => [a.id, a]));
    return (memberId: string): Who => {
      const a = byId.get(memberId);
      return a
        ? { name: a.name, colorVar: a.colorVar }
        : { name: memberId, colorVar: "var(--cli-idle)" };
    };
  }, [agents]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: stick to bottom on new turns
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [turns]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="cli-mono flex items-center px-4 pt-3 pb-2 text-[9.5px] uppercase tracking-[0.13em] text-muted-foreground/80">
        Console
        <span
          className="ml-1.5 inline-flex items-center gap-1 rounded-full px-1.5 text-[8px] not-italic"
          style={{ color: "var(--cli-run)" }}
        >
          <span
            className="cli-dot cli-dot-run"
            style={{ width: 5, height: 5 }}
          />
          live
        </span>
        <span className="ml-auto normal-case tracking-normal text-muted-foreground/60">
          {feed.length} events
        </span>
      </div>
      {turns.length === 0 ? (
        <div className="cli-mono px-4 pb-4 text-[11px] text-muted-foreground/60">
          waiting for activity…
        </div>
      ) : (
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {turns.map((turn) => (
            <TurnBlock key={turn.key} turn={turn} who={whoOf(turn.memberId)} />
          ))}
        </div>
      )}
    </div>
  );
}
