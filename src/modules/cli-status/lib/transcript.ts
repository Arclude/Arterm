// Pure, DOM-free transform: the store's rolling event feed → readable turns for
// the live console. Defensive by design — the desktop treats event payloads as
// `{ seq, ts, type } & Record<string, unknown>` (see types.ts), so every field is
// extracted with fallbacks and unknown event types are ignored (never fabricated).
// `team_member_event`s are unwrapped and attributed to their member id; everything
// else is attributed to "main". Coloring/naming is left to the component (which has
// the agent roster) — this stays a pure data shape so it's unit-testable.

import type { StampedEvent } from "../types";

const asString = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;

function toolName(o: Record<string, unknown>): string | undefined {
  const call = asRecord(o.call);
  const callName = call
    ? (asString(call.name) ?? asString(call.tool))
    : undefined;
  return (
    asString(o.tool) ?? asString(o.name) ?? asString(o.toolName) ?? callName
  );
}

function toolCallId(o: Record<string, unknown>): string | undefined {
  const call = asRecord(o.call);
  return (
    asString(o.id) ??
    asString(o.callId) ??
    asString(o.toolCallId) ??
    (call ? asString(call.id) : undefined)
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** One-line summary of a tool call's arguments (object → compact JSON, capped). */
function summarizeArgs(o: Record<string, unknown>): string | undefined {
  const call = asRecord(o.call);
  const a =
    o.args ??
    o.input ??
    o.arguments ??
    (call ? (call.arguments ?? call.args ?? call.input) : undefined);
  if (a == null) return undefined;
  if (typeof a === "string") return truncate(a, 140) || undefined;
  try {
    return truncate(JSON.stringify(a), 140);
  } catch {
    return undefined;
  }
}

/** tool_result output text — the CLI event carries `output: string`. */
const outputOf = (o: Record<string, unknown>): string | undefined =>
  asString(o.output) ??
  asString(o.result) ??
  asString(o.content) ??
  asString(o.text);

/** Assistant prose — the CLI wraps it as `assistant_message.message.content`
 *  (Message.content: string). Fall back to flat fields defensively. */
function assistantText(o: Record<string, unknown>): string | undefined {
  const msg = asRecord(o.message);
  return (
    (msg ? asString(msg.content) : undefined) ??
    asString(o.text) ??
    asString(o.content)
  );
}

export type TranscriptTool = {
  seq: number;
  name: string;
  /** id used to match a tool_result back to its call (best-effort). */
  callId?: string;
  args?: string;
  output?: string;
  /** DiffRow[] from a tool_result (`{kind,old?,new?,text}`); rendered red/green. */
  diff?: unknown;
  /** File the tool changed (tool_result `path`), shown as a diff header. */
  path?: string;
  denied?: boolean;
  isError?: boolean;
};

export type TranscriptTurn = {
  key: string;
  /** "main" or a team member id — the component resolves name + color. */
  memberId: string;
  ts: number;
  seq: number;
  /** Assistant message text, when the event carried it. */
  text?: string;
  tools: TranscriptTool[];
};

type Effective = { who: string; obj: Record<string, unknown>; type: string };

/** Resolve the effective payload + owner: unwrap `team_member_event`, else top-level. */
function effective(ev: StampedEvent): Effective {
  if (ev.type === "team_member_event") {
    const inner = asRecord(ev.event) ?? {};
    return {
      who: asString(ev.id) ?? "main",
      obj: inner,
      type: asString(inner.type) ?? "",
    };
  }
  return { who: "main", obj: ev, type: ev.type };
}

/** Match a tool_result to the most recent open tool in a turn (by id, else the
 *  last one still lacking output). */
function matchTool(
  turn: TranscriptTurn,
  callId: string | undefined,
): TranscriptTool | undefined {
  if (callId) {
    for (let i = turn.tools.length - 1; i >= 0; i--) {
      const t = turn.tools[i];
      if (t && t.callId === callId) return t;
    }
  }
  for (let i = turn.tools.length - 1; i >= 0; i--) {
    const t = turn.tools[i];
    if (t && t.output === undefined && t.diff === undefined && !t.denied) {
      return t;
    }
  }
  return undefined;
}

/**
 * Group the feed into turns. A new assistant message opens a turn owned by its
 * author; tool_call / tool_result / tool_denied / error events attach to that
 * author's current turn (a bare turn is created if tools arrive before any
 * message). Order is preserved; other event types are ignored.
 */
export function buildTranscript(feed: StampedEvent[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  const current = new Map<string, TranscriptTurn>();

  const openTurn = (who: string, ts: number, seq: number, text?: string) => {
    const turn: TranscriptTurn = {
      key: `${who}:${seq}`,
      memberId: who,
      ts,
      seq,
      text,
      tools: [],
    };
    turns.push(turn);
    current.set(who, turn);
    return turn;
  };

  const ensureTurn = (who: string, ts: number, seq: number) =>
    current.get(who) ?? openTurn(who, ts, seq);

  for (const ev of feed) {
    const { who, obj, type } = effective(ev);
    const ts = ev.ts;
    const seq = ev.seq;
    switch (type) {
      case "assistant_message":
      case "message":
        openTurn(who, ts, seq, assistantText(obj) ?? undefined);
        break;
      case "tool_call":
        ensureTurn(who, ts, seq).tools.push({
          seq,
          name: toolName(obj) ?? "tool",
          callId: toolCallId(obj),
          args: summarizeArgs(obj),
        });
        break;
      case "tool_result": {
        const turn = current.get(who);
        const target = turn ? matchTool(turn, toolCallId(obj)) : undefined;
        const path = asString(obj.path);
        if (target) {
          target.output = outputOf(obj);
          if (obj.diff !== undefined) target.diff = obj.diff;
          if (path !== undefined) target.path = path;
          if (obj.isError === true) target.isError = true;
        } else {
          ensureTurn(who, ts, seq).tools.push({
            seq,
            name: toolName(obj) ?? "result",
            callId: toolCallId(obj),
            output: outputOf(obj),
            diff: obj.diff,
            path,
            isError: obj.isError === true,
          });
        }
        break;
      }
      case "tool_denied":
        ensureTurn(who, ts, seq).tools.push({
          seq,
          name: toolName(obj) ?? "tool",
          denied: true,
        });
        break;
      case "error":
        ensureTurn(who, ts, seq).tools.push({
          seq,
          name: "error",
          output: asString(obj.message) ?? "error",
          isError: true,
        });
        break;
      default:
        break; // team_plan / team_done / team_member_state / usage → not shown
    }
  }
  return turns;
}
