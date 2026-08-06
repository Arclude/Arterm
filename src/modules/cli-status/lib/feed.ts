// Builds the dashboard's global live-activity feed from the per-session stamped
// events the store already keeps. Defensive by design: the desktop treats event
// payloads as opaque `{ seq, ts, type } & Record<string, unknown>`, so we only
// render event types we can describe confidently and skip the rest (never
// fabricate). `team_member_event` frames are unwrapped and attributed to their
// member so a row shows who did what.

import type { CliSessionEntry } from "../store/cliStatusStore";
import type { StampedEvent } from "../types";
import { basename, type DerivedAgent, deriveAgents } from "./dashboard";

export type FeedRow = {
  key: string;
  ts: number;
  glyph: string;
  who: string;
  whoColor: string;
  text: string;
};

const asString = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

function toolName(o: Record<string, unknown>): string | undefined {
  const call = o.call;
  const callName =
    call && typeof call === "object"
      ? (asString((call as Record<string, unknown>).name) ??
        asString((call as Record<string, unknown>).tool))
      : undefined;
  return (
    asString(o.tool) ?? asString(o.name) ?? asString(o.toolName) ?? callName
  );
}

/**
 * A verification verdict, which has THREE outcomes and never two: `skipped` means
 * no verdict could be obtained and the claim passed by default. "Unverified" is
 * not "verified" — collapsing them would draw a green check for a dead API key,
 * and the whole point of the gate is that its silence is visible.
 *
 * A payload with no boolean `pass` is skipped rather than guessed at: this feed
 * never invents a verdict it did not receive.
 */
function describeVerdict(
  o: Record<string, unknown>,
): { glyph: string; text: string } | null {
  if (typeof o.pass !== "boolean") return null;
  const scope = asString(o.scope);
  const id = asString(o.id);
  // "goal" is the whole run and needs no qualifier; a phase/round/task says which.
  const at = `${scope && scope !== "goal" ? ` ${scope}` : ""}${id ? ` ${id}` : ""}`;
  const note = asString(o.note);
  const tail = note ? ` — ${note}` : "";
  if (o.skipped === true) return { glyph: "?", text: `unverified${at}${tail}` };
  if (o.pass) return { glyph: "✔", text: `verified${at}` };
  // Which half rejected is worth a word: the command gate is an exit code, the
  // judge an opinion, and they are argued with differently. The attempt number
  // says whether this is the first complaint or the fifth.
  const by = asString(o.by);
  const attempt =
    typeof o.attempt === "number" ? ` · attempt ${o.attempt}` : "";
  // The actual items, not just a count: a truncated row still shows the first
  // fix, and the full list rides the row's tooltip.
  const fixes = Array.isArray(o.mustFix)
    ? o.mustFix.filter((f): f is string => typeof f === "string")
    : [];
  const toFix = fixes.length > 0 ? ` · fix: ${fixes.join("; ")}` : "";
  return {
    glyph: "✘",
    text: `verification failed${at}${by ? ` (${by})` : ""}${attempt}${tail}${toFix}`,
  };
}

/** Journal statuses → glyphs: what an eternal step amounted to, at a glance.
 *  Exported so the session detail panel draws the same diary the feed does. */
export const JOURNAL_GLYPH: Record<string, string> = {
  ok: "•",
  idle: "○",
  error: "✘",
  loop: "↻",
  "verify-fail": "✘",
};

/** Human-readable {glyph, text} for a known event type, or null to skip it. */
function describe(
  type: string,
  o: Record<string, unknown>,
): { glyph: string; text: string } | null {
  switch (type) {
    case "tool_call":
      return { glyph: "⚙", text: toolName(o) ?? "tool call" };
    case "assistant_message":
    case "message":
      return { glyph: "✎", text: "writing" };
    case "tool_denied":
      return { glyph: "⊘", text: `denied ${toolName(o) ?? ""}`.trim() };
    case "error":
      return { glyph: "✘", text: asString(o.message) ?? "error" };
    case "team_plan":
      return { glyph: "◆", text: "team planned" };
    case "team_done":
      return { glyph: "✔", text: "team finished" };
    case "team_member_state": {
      const state = asString(o.state);
      return state ? { glyph: "•", text: `→ ${state}` } : null;
    }
    case "autonomy_verify":
      return describeVerdict(o);
    // Run endings: why a run stopped is as much a fact as that it stopped —
    // without these the pill turns red/green and the feed says nothing.
    case "autonomy_done": {
      const summary = asString(o.summary);
      return {
        glyph: "✔",
        text: `goal complete${summary ? ` — ${summary}` : ""}`,
      };
    }
    case "autonomy_stopped": {
      const reason = asString(o.reason);
      return { glyph: "■", text: `stopped${reason ? ` — ${reason}` : ""}` };
    }
    // Loop detector (steer-then-cut): the difference between "steered" and
    // "cut" is the difference between a nudge and an ended turn.
    case "loop_detected": {
      const streak = typeof o.streak === "number" ? ` ×${o.streak}` : "";
      return { glyph: "↻", text: `repeating${streak} — steered` };
    }
    case "loop_cut": {
      const streak = typeof o.streak === "number" ? ` ×${o.streak}` : "";
      return { glyph: "↻", text: `loop cut${streak} — turn ended` };
    }
    // Run budget. The soft crossing is a REQUEST to wrap up and the hard one is
    // a refusal to send the next request — a run that chose to finish and one
    // that was stopped look the same in the transcript otherwise.
    case "budget_warning": {
      const spent = typeof o.spent === "string" ? ` (${o.spent})` : "";
      return {
        glyph: "◔",
        text: `budget soft limit${spent} — asked to wrap up`,
      };
    }
    case "budget_exceeded": {
      const spent = typeof o.spent === "string" ? ` (${o.spent})` : "";
      return { glyph: "●", text: `budget spent${spent} — run stopped` };
    }
    // Progress-gated step extension: the cap moved because work was happening.
    case "autonomy_extended": {
      const limit = typeof o.newLimit === "number" ? ` → ${o.newLimit}` : "";
      return { glyph: "⤒", text: `step limit extended${limit}` };
    }
    // Eternal-mode provider backoff: the run is waiting, not wedged.
    case "autonomy_backoff": {
      const secs =
        typeof o.ms === "number" ? ` ${Math.round(o.ms / 1000)}s` : "";
      const attempt =
        typeof o.attempt === "number" ? ` (attempt ${o.attempt})` : "";
      return { glyph: "…", text: `backing off${secs}${attempt}` };
    }
    // Eternal journal: one classified line per step — the run's own diary.
    case "autonomy_journal": {
      const status = asString(o.status);
      const note = asString(o.note);
      if (!status) return null;
      return {
        glyph: JOURNAL_GLYPH[status] ?? "•",
        text: `[${status}]${note ? ` ${note}` : ""}`,
      };
    }
    default:
      return null;
  }
}

function describeStamped(
  ev: StampedEvent,
  byId: Map<string, DerivedAgent>,
  sessionName: string,
  sessionId: string,
): FeedRow | null {
  let type = ev.type;
  let obj: Record<string, unknown> = ev;
  let who = sessionName;
  let whoColor = "var(--cli-a-cyan)";

  if (type === "team_member_event") {
    const member = asString(ev.id) ? byId.get(ev.id as string) : undefined;
    if (member) {
      who = member.name;
      whoColor = member.colorVar;
    }
    const inner = ev.event;
    if (inner && typeof inner === "object") {
      const innerObj = inner as Record<string, unknown>;
      const innerType = asString(innerObj.type);
      if (innerType) {
        type = innerType;
        obj = innerObj;
      }
    }
  }

  // A per-task verdict belongs under the worker whose work was judged, not under
  // the session: in a fan-out the interesting question is WHICH task was rejected,
  // and `id` is the same board-row id the graph already draws.
  if (type === "autonomy_verify") {
    const row = asString(ev.id) ? byId.get(ev.id as string) : undefined;
    if (row) {
      who = row.name;
      whoColor = row.colorVar;
    }
  }

  const d = describe(type, obj);
  if (!d) return null;
  return {
    key: `${sessionId}:${ev.seq}`,
    ts: ev.ts,
    glyph: d.glyph,
    who,
    whoColor,
    text: d.text,
  };
}

/** Merge the recent activity across all live sessions, newest first. */
export function buildGlobalFeed(
  entries: CliSessionEntry[],
  limit = 40,
): FeedRow[] {
  const rows: FeedRow[] = [];
  for (const entry of entries) {
    if (entry.connection === "lost" || !entry.snapshot) continue;
    const agents = deriveAgents(entry.snapshot);
    const byId = new Map(agents.map((a) => [a.id, a]));
    const sessionName = basename(entry.info.cwd);
    for (const ev of entry.feed) {
      const row = describeStamped(ev, byId, sessionName, entry.info.sessionId);
      if (row) rows.push(row);
    }
  }
  rows.sort((a, b) => b.ts - a.ts);
  return rows.slice(0, limit);
}
