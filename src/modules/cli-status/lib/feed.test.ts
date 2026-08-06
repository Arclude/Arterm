import { describe, expect, it } from "vitest";
import type { CliSessionEntry } from "../store/cliStatusStore";
import type { StampedEvent, StatusSnapshot, TeamMemberStatus } from "../types";
import { buildGlobalFeed } from "./feed";

function member(over: Partial<TeamMemberStatus> = {}): TeamMemberStatus {
  return {
    id: "t2",
    name: "@builder",
    description: "",
    adhoc: false,
    state: "running",
    toolUseCount: 0,
    tokenCount: 0,
    recentActivities: [],
    ...over,
  };
}

function snapshot(over: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    v: 1,
    pid: 1,
    sessionId: "s",
    cwd: "/proj",
    startedAt: 1000,
    status: "idle",
    model: "m",
    provider: "p",
    permissionMode: "ask",
    toolCount: 0,
    tokens: { in: 0, out: 0, ctx: 0 },
    activeTool: null,
    rounds: 0,
    autonomy: {
      state: "idle",
      mode: "once",
      goal: "",
      step: 0,
      phases: [],
      team: [],
    },
    fleet: { active: 0, round: 0 },
    workers: [],
    team: [],
    main: { toolUseCount: 0, recentActivities: [] },
    activeAgents: 0,
    seq: 0,
    ...over,
  };
}

/** One live session whose feed is exactly `events`. */
function entryWith(
  events: StampedEvent[],
  snap: StatusSnapshot = snapshot(),
): CliSessionEntry {
  return {
    info: {
      v: 1,
      pid: 1,
      sessionId: snap.sessionId,
      port: 1,
      token: "t",
      cwd: snap.cwd,
      startedAt: snap.startedAt,
    },
    snapshot: snap,
    connection: "live",
    feed: events,
  };
}

const verify = (over: Record<string, unknown>): StampedEvent => ({
  seq: 1,
  ts: 1,
  type: "autonomy_verify",
  ...over,
});

function rows(events: StampedEvent[], snap?: StatusSnapshot) {
  return buildGlobalFeed([entryWith(events, snap)]);
}

describe("buildGlobalFeed · verification verdicts", () => {
  it("renders an accepted claim, unqualified for the whole goal", () => {
    const [row] = rows([verify({ pass: true, scope: "goal" })]);
    expect(row?.glyph).toBe("✔");
    expect(row?.text).toBe("verified");
  });

  it("says which unit of work was judged when it is not the goal", () => {
    const [row] = rows([verify({ pass: true, scope: "task", id: "t2" })]);
    expect(row?.text).toBe("verified task t2");
  });

  it("reports a rejection with the half that rejected and the repair count", () => {
    const [row] = rows([
      verify({
        pass: false,
        scope: "task",
        id: "t2",
        by: "judge",
        note: "the tests were never run",
        mustFix: ["run the suite", "fix the failing case"],
      }),
    ]);
    expect(row?.glyph).toBe("✘");
    expect(row?.text).toBe(
      "verification failed task t2 (judge) — the tests were never run · fix: run the suite; fix the failing case",
    );
  });

  it("keeps 'unverified' distinct from 'verified'", () => {
    // `skipped` means NO verdict was obtained and the claim passed by default.
    // Drawing this as a green check would report a dead API key as success.
    const [row] = rows([
      verify({ pass: true, skipped: true, note: "the verifier itself failed" }),
    ]);
    expect(row?.glyph).toBe("?");
    expect(row?.text).toBe("unverified — the verifier itself failed");
  });

  it("skips a payload with no verdict rather than inventing one", () => {
    expect(rows([verify({ scope: "goal" })])).toHaveLength(0);
    expect(rows([verify({ pass: "yes" })])).toHaveLength(0);
  });

  it("attributes a per-task verdict to the worker whose work was judged", () => {
    const snap = snapshot({ team: [member({ id: "t2", name: "@builder" })] });
    const [row] = rows(
      [verify({ pass: false, scope: "task", id: "t2" })],
      snap,
    );
    expect(row?.who).toBe("@builder");
    // ...and wears that row's colour rather than the session's default cyan.
    expect(row?.whoColor).not.toBe("var(--cli-a-cyan)");
  });

  it("falls back to the session when the verdict names no known row", () => {
    const [row] = rows([verify({ pass: true, scope: "phase", id: "p1" })]);
    expect(row?.who).toBe("proj"); // basename of the session cwd
  });
});

describe("buildGlobalFeed · unattended-run events", () => {
  const ev = (
    type: string,
    over: Record<string, unknown> = {},
  ): StampedEvent => ({
    seq: 1,
    ts: 1,
    type,
    ...over,
  });

  it("renders run endings with their reason/summary", () => {
    const [done] = rows([ev("autonomy_done", { summary: "all tests green" })]);
    expect(done?.glyph).toBe("✔");
    expect(done?.text).toBe("goal complete — all tests green");
    const [stopped] = rows([
      ev("autonomy_stopped", { reason: "reached step limit (4)" }),
    ]);
    expect(stopped?.glyph).toBe("■");
    expect(stopped?.text).toBe("stopped — reached step limit (4)");
  });

  it("tells a loop steer apart from a loop cut", () => {
    const [steered] = rows([ev("loop_detected", { streak: 3 })]);
    expect(steered?.text).toBe("repeating ×3 — steered");
    const [cut] = rows([ev("loop_cut", { streak: 5 })]);
    expect(cut?.text).toBe("loop cut ×5 — turn ended");
  });

  it("tells a budget wrap-up request apart from a budget stop", () => {
    // A run that CHOSE to finish and one that was refused its next request look
    // the same in the transcript; the feed is where the difference lives.
    const [soft] = rows([ev("budget_warning", { spent: "$3.80/$5" })]);
    expect(soft?.text).toBe("budget soft limit ($3.80/$5) — asked to wrap up");
    const [hard] = rows([ev("budget_exceeded", { spent: "$5.00/$5" })]);
    expect(hard?.text).toBe("budget spent ($5.00/$5) — run stopped");
  });

  it("renders extensions, backoffs, and journal lines", () => {
    const [ext] = rows([ev("autonomy_extended", { newLimit: 50 })]);
    expect(ext?.text).toBe("step limit extended → 50");
    const [back] = rows([ev("autonomy_backoff", { ms: 4000, attempt: 2 })]);
    expect(back?.text).toBe("backing off 4s (attempt 2)");
    const [line] = rows([
      ev("autonomy_journal", { status: "ok", note: "used write, bash" }),
    ]);
    expect(line?.glyph).toBe("•");
    expect(line?.text).toBe("[ok] used write, bash");
  });

  it("includes the attempt number on a rejection", () => {
    const [row] = rows([verify({ pass: false, attempt: 3 })]);
    expect(row?.text).toBe("verification failed · attempt 3");
  });

  it("skips a journal event with no status rather than inventing one", () => {
    expect(rows([ev("autonomy_journal", { note: "??" })])).toHaveLength(0);
  });
});
