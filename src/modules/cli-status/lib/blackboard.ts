// Pure derivation for the Blackboard panel — turns a session's SSE feed into a
// flat, newest-first list of team postings. DOM-free so it is unit-testable
// without a renderer (mirrors the topology.ts / topology.test.ts split). The
// blackboard content lives ONLY in the stream (never the snapshot), so this is
// the sole place the raw teammate text is surfaced as a readable log.

import type { StampedEvent } from "../types";
import { asTeamMessage } from "./topology";

/** One blackboard posting, flattened for display. `directed` = a member→member
 *  note (`kind:"message"` with a `to`); an undirected message is a broadcast and
 *  `kind:"result"` is a member's round output posted to the board. */
export type BlackboardRow = {
  seq: number;
  round: number;
  fromName: string;
  toName?: string;
  directed: boolean;
  kind: "message" | "result";
  text: string;
};

/**
 * Derive the blackboard log from a session's event feed, newest posting first
 * (by sink sequence, so it is stable regardless of feed order). Non-`team_message`
 * events and malformed payloads are dropped defensively.
 */
export function toBlackboardRows(feed: StampedEvent[]): BlackboardRow[] {
  const rows: BlackboardRow[] = [];
  for (const ev of feed) {
    const m = asTeamMessage(ev);
    if (!m) continue;
    rows.push({
      seq: m.seq,
      round: m.round,
      fromName: m.fromName,
      toName: m.kind === "message" ? m.toName : undefined,
      directed: m.kind === "message" && m.to !== undefined,
      kind: m.kind,
      text: m.text,
    });
  }
  rows.sort((a, b) => b.seq - a.seq);
  return rows;
}

/** Count of directed member↔member notes (the headline "teammates actually
 *  talked" signal, as opposed to round results posted to the board). */
export function directedCount(rows: BlackboardRow[]): number {
  return rows.filter((r) => r.directed).length;
}
