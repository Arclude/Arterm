import { describe, expect, it } from "vitest";
import type { StampedEvent } from "../types";
import { directedCount, toBlackboardRows } from "./blackboard";

/** A stamped `team_message` blackboard posting for the feed. */
function msg(seq: number, over: Record<string, unknown>): StampedEvent {
  return { seq, ts: seq * 1000, type: "team_message", ...over };
}

describe("toBlackboardRows", () => {
  it("returns [] for an empty feed", () => {
    expect(toBlackboardRows([])).toEqual([]);
  });

  it("ignores non-team_message events and malformed payloads", () => {
    const feed: StampedEvent[] = [
      { seq: 1, ts: 1000, type: "tool_call", tool: "read" },
      { seq: 2, ts: 2000, type: "team_message" }, // missing from/kind → dropped
      msg(3, {
        round: 1,
        from: "a",
        fromName: "@a",
        kind: "message",
        text: "hi",
      }),
    ];
    const rows = toBlackboardRows(feed);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fromName).toBe("@a");
  });

  it("flags a directed member→member note and carries the recipient", () => {
    const rows = toBlackboardRows([
      msg(1, {
        round: 2,
        from: "a",
        fromName: "@a",
        to: "b",
        toName: "@b",
        kind: "message",
        text: "the Task interface has id/title/done",
      }),
    ]);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r?.directed).toBe(true);
    expect(r?.kind).toBe("message");
    expect(r?.fromName).toBe("@a");
    expect(r?.toName).toBe("@b");
    expect(r?.round).toBe(2);
    expect(r?.text).toContain("Task interface");
  });

  it("treats a message with no recipient as an undirected broadcast", () => {
    const rows = toBlackboardRows([
      msg(1, {
        round: 1,
        from: "a",
        fromName: "@a",
        kind: "message",
        text: "hey all",
      }),
    ]);
    expect(rows[0]?.directed).toBe(false);
    expect(rows[0]?.toName).toBeUndefined();
  });

  it("never marks a result as directed, dropping any stray recipient", () => {
    const rows = toBlackboardRows([
      msg(1, {
        round: 1,
        from: "a",
        fromName: "@a",
        to: "b",
        toName: "@b",
        kind: "result",
        text: "wrote model.ts",
      }),
    ]);
    expect(rows[0]?.kind).toBe("result");
    expect(rows[0]?.directed).toBe(false);
    expect(rows[0]?.toName).toBeUndefined();
  });

  it("orders postings newest-first by sink sequence, regardless of feed order", () => {
    const feed: StampedEvent[] = [
      msg(2, {
        round: 1,
        from: "a",
        fromName: "@a",
        kind: "result",
        text: "second",
      }),
      msg(1, {
        round: 1,
        from: "b",
        fromName: "@b",
        kind: "message",
        text: "first",
      }),
      msg(3, {
        round: 2,
        from: "a",
        fromName: "@a",
        kind: "message",
        text: "third",
      }),
    ];
    const rows = toBlackboardRows(feed);
    expect(rows.map((r) => r.text)).toEqual(["third", "second", "first"]);
  });
});

describe("directedCount", () => {
  it("counts only directed member↔member notes", () => {
    const rows = toBlackboardRows([
      msg(1, {
        round: 1,
        from: "a",
        fromName: "@a",
        to: "b",
        toName: "@b",
        kind: "message",
        text: "x",
      }),
      msg(2, {
        round: 1,
        from: "a",
        fromName: "@a",
        kind: "message",
        text: "broadcast",
      }),
      msg(3, {
        round: 1,
        from: "b",
        fromName: "@b",
        kind: "result",
        text: "done",
      }),
    ]);
    expect(directedCount(rows)).toBe(1);
  });
});
