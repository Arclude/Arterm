import { useMemo } from "react";
import {
  type BlackboardRow,
  directedCount,
  toBlackboardRows,
} from "../lib/blackboard";
import type { StampedEvent } from "../types";

/** The shared team blackboard as a readable log. Reads the same stream-only
 *  `team_message` feed the topology graph draws edges from, but shows WHAT each
 *  teammate posted (message text + direction + round), newest first — the detail
 *  the graph can only hint at with a hover. */
export function BlackboardPanel({ feed }: { feed: StampedEvent[] }) {
  const rows = useMemo(() => toBlackboardRows(feed), [feed]);

  if (rows.length === 0) {
    return (
      <div className="cli-mono flex min-h-0 flex-1 items-center justify-center px-6 text-center text-[11px] leading-relaxed text-muted-foreground/60">
        Henüz kara tahta mesajı yok. Bir team run başlatın
        <br />(<code className="text-foreground/70">/team &lt;görev&gt;</code>)
        — üyeler koordine oldukça mesajlar burada birikir.
      </div>
    );
  }

  const directed = directedCount(rows);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="cli-mono flex items-center gap-1.5 border-b border-border/60 px-4 py-2 text-[9.5px] uppercase tracking-[0.12em] text-muted-foreground/70">
        {rows.length} posting
        <span style={{ color: "var(--cli-a-purple)" }}>
          · {directed} teammate ✉
        </span>
      </div>
      <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-3 py-2">
        {rows.map((r) => (
          <BlackboardRowItem key={r.seq} row={r} />
        ))}
      </ul>
    </div>
  );
}

function BlackboardRowItem({ row }: { row: BlackboardRow }) {
  const color = row.directed ? "var(--cli-a-purple)" : "var(--cli-idle)";
  const tag = row.directed
    ? "✉ message"
    : row.kind === "result"
      ? "◆ result"
      : "broadcast";
  return (
    <li className="rounded-lg border border-border/50 bg-card/40 px-2.5 py-1.5">
      <div className="cli-mono flex items-center gap-1.5 text-[9.5px] text-muted-foreground/80">
        <span
          className="rounded px-1 py-px font-semibold"
          style={{
            color,
            background: "color-mix(in oklab, var(--cli-idle) 20%, transparent)",
          }}
        >
          {tag}
        </span>
        <span className="truncate text-foreground/85">{row.fromName}</span>
        <span className="text-muted-foreground/50">→</span>
        <span className="truncate text-foreground/70">
          {row.toName ?? "herkes"}
        </span>
        <span className="ml-auto shrink-0 text-muted-foreground/55">
          round {row.round}
        </span>
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words text-[11.5px] leading-snug text-foreground/85">
        {row.text || <span className="text-muted-foreground/50">(boş)</span>}
      </p>
    </li>
  );
}
