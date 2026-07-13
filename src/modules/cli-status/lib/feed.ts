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
