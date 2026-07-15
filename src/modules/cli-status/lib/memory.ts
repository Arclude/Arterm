// Pure derivation for the member Memos panel — turns a session's SSE feed into
// per-member private-memory groups. DOM-free so it is unit-testable without a
// renderer (mirrors the blackboard.ts / blackboard.test.ts split). Memos live
// ONLY in the stream (never the snapshot), so this is the sole place a member's
// private notes-to-self are surfaced. Like the blackboard, this applies no cap
// of its own: it derives from the store's rolling feed (FEED_CAP), so the memo
// log is bounded by the same window.

import type { StampedEvent, TeamMemoryEvent } from "../types";

/** Narrow a stream event to a `team_memory` note, validating every field
 *  defensively (the desktop treats payloads as opaque). `kind: "note"` is the
 *  only kind in the contract today, and the contract says unknown kinds are
 *  ignorable — so anything else returns null. */
export function asTeamMemory(ev: StampedEvent): TeamMemoryEvent | null {
  if (ev.type !== "team_memory") return null;
  const member = typeof ev.member === "string" ? ev.member : undefined;
  if (!member || ev.kind !== "note") return null;
  return {
    ...ev,
    type: "team_memory",
    round: typeof ev.round === "number" ? ev.round : 0,
    member,
    memberName: typeof ev.memberName === "string" ? ev.memberName : member,
    kind: "note",
    text: typeof ev.text === "string" ? ev.text : "",
  };
}

/** One private note, flattened for display. */
export type MemoryNote = {
  seq: number;
  round: number;
  text: string;
};

/** One member's accumulated private memory, `notes` newest first. */
export type MemberMemory = {
  member: string;
  memberName: string;
  notes: MemoryNote[];
};

/**
 * Derive per-member memo groups from a session's event feed. Notes within a
 * group are newest first by sink sequence (stable regardless of feed order),
 * and groups are ordered by their newest note — the most recently remembering
 * member floats to the top. Non-`team_memory` events, malformed payloads and
 * unknown kinds are dropped defensively.
 */
export function toMemoryGroups(feed: StampedEvent[]): MemberMemory[] {
  const byMember = new Map<string, MemberMemory>();
  for (const ev of feed) {
    const m = asTeamMemory(ev);
    if (!m) continue;
    const existing = byMember.get(m.member);
    const note: MemoryNote = { seq: m.seq, round: m.round, text: m.text };
    if (existing) {
      existing.notes.push(note);
      // Latest name wins (member names are stable in practice).
      existing.memberName = m.memberName;
    } else {
      byMember.set(m.member, {
        member: m.member,
        memberName: m.memberName,
        notes: [note],
      });
    }
  }
  const groups = [...byMember.values()];
  for (const g of groups) g.notes.sort((a, b) => b.seq - a.seq);
  groups.sort((a, b) => (b.notes[0]?.seq ?? 0) - (a.notes[0]?.seq ?? 0));
  return groups;
}

/** Total note count across all members (the panel's headline number). */
export function noteCount(groups: MemberMemory[]): number {
  return groups.reduce((n, g) => n + g.notes.length, 0);
}
