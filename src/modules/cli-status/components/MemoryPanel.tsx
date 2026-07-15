import { useMemo } from "react";
import { type MemberMemory, noteCount, toMemoryGroups } from "../lib/memory";
import type { StampedEvent } from "../types";

/** Each member's private memory as a readable log, grouped per member. Reads
 *  the stream-only `team_memory` feed — the notes a member left its future self
 *  via its `memo` tool. The blackboard shows what a member SHARED; this shows
 *  what it KEPT (a decision, a ruled-out approach) to survive into its next
 *  round. Newest note first within each member. */
export function MemoryPanel({ feed }: { feed: StampedEvent[] }) {
  const groups = useMemo(() => toMemoryGroups(feed), [feed]);

  if (groups.length === 0) {
    return (
      <div className="cli-mono flex min-h-0 flex-1 items-center justify-center px-6 text-center text-[11px] leading-relaxed text-muted-foreground/60">
        Henüz üye notu yok. Bir team run başlatın
        <br />(<code className="text-foreground/70">/team &lt;görev&gt;</code>)
        — üyeler kendilerine memo bıraktıkça notlar burada birikir.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="cli-mono flex items-center gap-1.5 border-b border-border/60 px-4 py-2 text-[9.5px] uppercase tracking-[0.12em] text-muted-foreground/70">
        {noteCount(groups)} memo
        <span style={{ color: "var(--cli-a-purple)" }}>
          · {groups.length} üye
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3 py-2">
        {groups.map((g) => (
          <MemberMemoryGroup key={g.member} group={g} />
        ))}
      </div>
    </div>
  );
}

function MemberMemoryGroup({ group }: { group: MemberMemory }) {
  return (
    <section>
      <div className="cli-mono flex items-center gap-1.5 px-0.5 pb-1 text-[9.5px] text-muted-foreground/80">
        <span
          className="rounded px-1 py-px font-semibold"
          style={{
            color: "var(--cli-a-purple)",
            background: "color-mix(in oklab, var(--cli-idle) 20%, transparent)",
          }}
        >
          ✎ memo
        </span>
        <span className="truncate text-foreground/85">{group.memberName}</span>
        <span className="ml-auto shrink-0 text-muted-foreground/55">
          {group.notes.length} not
        </span>
      </div>
      <ul className="flex flex-col gap-1.5">
        {group.notes.map((n) => (
          <li
            key={n.seq}
            className="rounded-lg border border-border/50 bg-card/40 px-2.5 py-1.5"
          >
            <div className="cli-mono text-[9.5px] text-muted-foreground/55">
              round {n.round}
            </div>
            <p className="mt-0.5 whitespace-pre-wrap break-words text-[11.5px] leading-snug text-foreground/85">
              {n.text || (
                <span className="text-muted-foreground/50">(boş)</span>
              )}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
