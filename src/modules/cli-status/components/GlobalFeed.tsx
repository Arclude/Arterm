import type { FeedRow } from "../lib/feed";

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toTimeString().slice(0, 8);
}

export function GlobalFeed({ rows }: { rows: FeedRow[] }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="cli-mono flex items-center px-4 pt-3 pb-2 text-[9.5px] uppercase tracking-[0.13em] text-muted-foreground/80">
        Live activity
        <span className="ml-auto normal-case tracking-normal text-muted-foreground/60">
          {rows.length} events
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="cli-mono px-4 pb-4 text-[11px] text-muted-foreground/60">
          waiting for activity…
        </div>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-4 pb-4">
          {rows.map((r) => (
            <li
              key={r.key}
              className="cli-mono grid grid-cols-[52px_12px_1fr] items-baseline gap-2 text-[10.5px] text-muted-foreground"
            >
              <span className="text-muted-foreground/60">{fmtTime(r.ts)}</span>
              <span style={{ color: "var(--cli-accent)" }}>{r.glyph}</span>
              <span className="min-w-0 truncate">
                <span className="font-semibold" style={{ color: r.whoColor }}>
                  {r.who}
                </span>{" "}
                <span className="text-muted-foreground/70">{r.text}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
