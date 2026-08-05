import { describe, expect, it } from "vitest";
import type { StampedEvent } from "../types";
import { journalTail, lastStopReason, lastVerdict } from "./autonomy";

let seq = 0;
const ev = (
  type: string,
  over: Record<string, unknown> = {},
): StampedEvent => ({
  seq: ++seq,
  ts: seq,
  type,
  ...over,
});

describe("lastVerdict", () => {
  it("returns the newest verdict with its mustFix items", () => {
    const feed = [
      ev("autonomy_verify", { pass: false, attempt: 1, mustFix: ["a"] }),
      ev("tool_call"),
      ev("autonomy_verify", {
        pass: false,
        attempt: 2,
        by: "command",
        note: "exit 3",
        mustFix: ["run the suite", 42, "fix the case"],
      }),
    ];
    const v = lastVerdict(feed);
    expect(v).toMatchObject({ pass: false, attempt: 2, by: "command" });
    // Non-string entries are dropped, never rendered as "42".
    expect(v?.mustFix).toEqual(["run the suite", "fix the case"]);
  });

  it("never reaches past a goal_set — an old run's verdict cannot haunt a new goal", () => {
    const feed = [
      ev("autonomy_verify", { pass: false }),
      ev("goal_set", { goal: "next" }),
      ev("tool_call"),
    ];
    expect(lastVerdict(feed)).toBeNull();
  });

  it("returns null for a payload with no boolean pass", () => {
    expect(lastVerdict([ev("autonomy_verify", { pass: "yes" })])).toBeNull();
  });
});

describe("lastStopReason", () => {
  it("returns the newest stop reason of the current run", () => {
    const feed = [
      ev("autonomy_stopped", { reason: "old" }),
      ev("goal_set", { goal: "g" }),
      ev("autonomy_stopped", { reason: "loop detected" }),
    ];
    expect(lastStopReason(feed)).toBe("loop detected");
  });

  it("is fenced by goal_set like the verdict", () => {
    const feed = [
      ev("autonomy_stopped", { reason: "old" }),
      ev("goal_set", { goal: "g" }),
    ];
    expect(lastStopReason(feed)).toBeNull();
  });
});

describe("journalTail", () => {
  it("returns the newest lines oldest-first, capped, fenced by goal_set", () => {
    const feed = [
      ev("autonomy_journal", { status: "ok", note: "previous run" }),
      ev("goal_set", { goal: "g" }),
      ...[1, 2, 3, 4, 5, 6].map((n) =>
        ev("autonomy_journal", {
          status: n % 2 ? "ok" : "error",
          note: `s${n}`,
        }),
      ),
    ];
    const tail = journalTail(feed, 5);
    expect(tail.map((l) => l.note)).toEqual(["s2", "s3", "s4", "s5", "s6"]);
    expect(tail[0]?.status).toBe("error");
  });

  it("skips lines with no status", () => {
    expect(journalTail([ev("autonomy_journal", { note: "x" })])).toEqual([]);
  });
});
