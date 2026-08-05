// Derives the autonomy detail panel's data from the per-session event feed the
// store already keeps. Nothing here adds to the CLI contract: verdicts, stop
// reasons, and journal lines all arrive as ring events — the snapshot says
// "stopped", the feed says why. Same defensive stance as feed.ts: payloads are
// opaque, so only confidently-typed fields are surfaced and nothing is guessed.

import type { StampedEvent } from "../types";

const asString = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

export type VerdictInfo = {
  ts: number;
  pass: boolean;
  skipped: boolean;
  by?: string;
  note?: string;
  attempt?: number;
  scope?: string;
  mustFix: string[];
};

/**
 * The most recent verification verdict of the CURRENT run: scanning stops at a
 * `goal_set`, so a verdict from a finished earlier run never haunts the panel
 * of a new goal.
 */
export function lastVerdict(feed: StampedEvent[]): VerdictInfo | null {
  for (let i = feed.length - 1; i >= 0; i--) {
    const ev = feed[i];
    if (ev.type === "goal_set") return null;
    if (ev.type !== "autonomy_verify") continue;
    if (typeof ev.pass !== "boolean") return null;
    return {
      ts: ev.ts,
      pass: ev.pass,
      skipped: ev.skipped === true,
      by: asString(ev.by),
      note: asString(ev.note),
      attempt: typeof ev.attempt === "number" ? ev.attempt : undefined,
      scope: asString(ev.scope),
      mustFix: Array.isArray(ev.mustFix)
        ? ev.mustFix.filter((f): f is string => typeof f === "string")
        : [],
    };
  }
  return null;
}

/**
 * Why the current run stopped, from the newest `autonomy_stopped` event — only
 * meaningful while the snapshot's autonomy state IS "stopped", so the caller
 * gates on that. Same `goal_set` fence as {@link lastVerdict}.
 */
export function lastStopReason(feed: StampedEvent[]): string | null {
  for (let i = feed.length - 1; i >= 0; i--) {
    const ev = feed[i];
    if (ev.type === "goal_set") return null;
    if (ev.type !== "autonomy_stopped") continue;
    return asString(ev.reason) ?? null;
  }
  return null;
}

export type JournalLine = {
  ts: number;
  status: string;
  note: string;
};

/**
 * The current run's newest journal lines (eternal mode's step diary), oldest
 * first — mirroring how the CLI prepends them to the next directive.
 */
export function journalTail(feed: StampedEvent[], limit = 5): JournalLine[] {
  const out: JournalLine[] = [];
  for (let i = feed.length - 1; i >= 0 && out.length < limit; i--) {
    const ev = feed[i];
    if (ev.type === "goal_set") break;
    if (ev.type !== "autonomy_journal") continue;
    const status = asString(ev.status);
    if (!status) continue;
    out.push({ ts: ev.ts, status, note: asString(ev.note) ?? "" });
  }
  return out.reverse();
}
