import { beforeEach, describe, expect, it } from "vitest";
import { useCliStatusStore } from "../store/cliStatusStore";
import type { CliSessionInfo, StampedEvent } from "../types";
import { asTeamMemory, noteCount, toMemoryGroups } from "./memory";

/** A stamped `team_memory` private note for the feed. */
function memo(seq: number, over: Record<string, unknown>): StampedEvent {
  return { seq, ts: seq * 1000, type: "team_memory", kind: "note", ...over };
}

describe("asTeamMemory", () => {
  it("narrows a well-formed note and fills defensive fallbacks", () => {
    const m = asTeamMemory(
      memo(7, { round: 2, member: "a", memberName: "@a", text: "use vitest" }),
    );
    expect(m).not.toBeNull();
    expect(m?.member).toBe("a");
    expect(m?.memberName).toBe("@a");
    expect(m?.round).toBe(2);
    expect(m?.kind).toBe("note");
    expect(m?.text).toBe("use vitest");
  });

  it("falls back to the member id when memberName is missing", () => {
    const m = asTeamMemory(memo(1, { round: 1, member: "a", text: "x" }));
    expect(m?.memberName).toBe("a");
  });

  it("returns null for other event types and malformed payloads", () => {
    expect(
      asTeamMemory({ seq: 1, ts: 1000, type: "tool_call", tool: "read" }),
    ).toBeNull();
    // Missing member → dropped.
    expect(
      asTeamMemory({ seq: 2, ts: 2000, type: "team_memory", kind: "note" }),
    ).toBeNull();
    // Non-string member → dropped.
    expect(
      asTeamMemory(memo(3, { round: 1, member: 42, text: "x" })),
    ).toBeNull();
  });

  it("ignores unknown kinds (forward-compat: only 'note' exists today)", () => {
    expect(
      asTeamMemory({
        seq: 1,
        ts: 1000,
        type: "team_memory",
        round: 1,
        member: "a",
        memberName: "@a",
        kind: "todo",
        text: "future kind",
      }),
    ).toBeNull();
    // Missing kind entirely is just as ignorable.
    expect(
      asTeamMemory({
        seq: 2,
        ts: 2000,
        type: "team_memory",
        round: 1,
        member: "a",
        text: "no kind",
      }),
    ).toBeNull();
  });
});

describe("toMemoryGroups", () => {
  it("returns [] for an empty feed", () => {
    expect(toMemoryGroups([])).toEqual([]);
  });

  it("drops non-team_memory events, malformed payloads and unknown kinds", () => {
    const feed: StampedEvent[] = [
      { seq: 1, ts: 1000, type: "tool_call", tool: "read" },
      { seq: 2, ts: 2000, type: "team_memory" }, // missing member/kind → dropped
      memo(3, { round: 1, member: "a", memberName: "@a", text: "keep me" }),
      memo(4, {
        round: 1,
        member: "a",
        memberName: "@a",
        kind: "todo",
        text: "drop me",
      }),
    ];
    const groups = toMemoryGroups(feed);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.notes).toHaveLength(1);
    expect(groups[0]?.notes[0]?.text).toBe("keep me");
  });

  it("groups notes per member, newest first by sink seq regardless of feed order", () => {
    const feed: StampedEvent[] = [
      memo(2, { round: 1, member: "a", memberName: "@a", text: "a-second" }),
      memo(1, { round: 1, member: "a", memberName: "@a", text: "a-first" }),
      memo(3, { round: 2, member: "b", memberName: "@b", text: "b-first" }),
      memo(4, { round: 2, member: "a", memberName: "@a", text: "a-third" }),
    ];
    const groups = toMemoryGroups(feed);
    expect(groups).toHaveLength(2);
    // Groups ordered by their newest note: a's seq 4 beats b's seq 3.
    expect(groups[0]?.member).toBe("a");
    expect(groups[0]?.notes.map((n) => n.text)).toEqual([
      "a-third",
      "a-second",
      "a-first",
    ]);
    expect(groups[1]?.member).toBe("b");
    expect(groups[1]?.notes[0]?.round).toBe(2);
  });

  it("counts notes across members", () => {
    const groups = toMemoryGroups([
      memo(1, { round: 1, member: "a", memberName: "@a", text: "x" }),
      memo(2, { round: 1, member: "b", memberName: "@b", text: "y" }),
      memo(3, { round: 2, member: "a", memberName: "@a", text: "z" }),
    ]);
    expect(noteCount(groups)).toBe(3);
  });
});

describe("memory accumulation cap (via the store's rolling feed)", () => {
  const info: CliSessionInfo = {
    v: 1,
    pid: 1000,
    sessionId: "s",
    port: 50000,
    token: "tok",
    cwd: "/proj",
    startedAt: 1,
  };

  beforeEach(() => {
    useCliStatusStore.setState({ sessions: {}, selectedSessionId: null });
  });

  it("is bounded by the store's FEED_CAP like the blackboard (oldest dropped)", () => {
    const store = useCliStatusStore.getState();
    store.upsertInfo(info);
    for (let i = 1; i <= 250; i++) {
      store.appendEvent(
        "s",
        memo(i, { round: 1, member: "a", memberName: "@a", text: `n${i}` }),
      );
    }
    const feed = useCliStatusStore.getState().sessions.s?.feed ?? [];
    const groups = toMemoryGroups(feed);
    expect(noteCount(groups)).toBe(200);
    const notes = groups[0]?.notes ?? [];
    expect(notes[0]?.seq).toBe(250); // newest kept
    expect(notes[notes.length - 1]?.seq).toBe(51); // oldest 50 dropped
  });
});
