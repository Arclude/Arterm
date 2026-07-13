import { describe, expect, it } from "vitest";
import type { CliSessionEntry } from "../store/cliStatusStore";
import type { StatusSnapshot, TeamMemberStatus } from "../types";
import {
  agentCounts,
  compact,
  computeKpis,
  deriveAgents,
  deriveWorkers,
  fmtElapsed,
  phaseProgress,
  sessionActivity,
  shareOfWork,
  sortSessionEntries,
} from "./dashboard";

function member(over: Partial<TeamMemberStatus> = {}): TeamMemberStatus {
  return {
    id: "m1",
    name: "@reviewer",
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

function liveEntry(snap: StatusSnapshot): CliSessionEntry {
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
    feed: [],
  };
}

describe("deriveAgents", () => {
  it("always leads with the main coordinator, then team members as children", () => {
    const agents = deriveAgents(
      snapshot({
        team: [
          member({ id: "a", name: "@a", toolUseCount: 12, tokenCount: 8400 }),
          member({ id: "b", name: "@b", state: "done" }),
        ],
      }),
    );
    expect(agents).toHaveLength(3); // main + 2 members
    expect(agents[0]?.id).toBe("main");
    expect(agents[0]?.kind).toBe("main");
    expect(agents[1]?.kind).toBe("member");
    expect(agents[1]?.toolUseCount).toBe(12);
    // main and every member get a distinct identity color.
    expect(agents[0]?.colorVar).not.toBe(agents[1]?.colorVar);
    expect(agents[1]?.colorVar).not.toBe(agents[2]?.colorVar);
  });

  it("is just the main for an empty team", () => {
    const agents = deriveAgents(
      snapshot({ status: "tool", tokens: { in: 100, out: 200, ctx: 50 } }),
    );
    expect(agents).toHaveLength(1);
    const main = agents[0];
    expect(main?.id).toBe("main");
    expect(main?.state).toBe("running"); // status "tool" → running
    expect(main?.tokenCount).toBe(300); // in + out
    expect(main?.startedAt).toBe(1000);
  });

  it("populates the main card from the snapshot's main telemetry", () => {
    const agents = deriveAgents(
      snapshot({
        main: { toolUseCount: 7, recentActivities: ["⚙ read", "✎ writing"] },
      }),
    );
    const main = agents[0];
    expect(main?.toolUseCount).toBe(7);
    expect(main?.recentActivities).toEqual(["⚙ read", "✎ writing"]);
  });

  it("derives the glyph from a member's activity prefix when present", () => {
    const agents = deriveAgents(
      snapshot({ team: [member({ activity: "⚙ grep foo" })] }),
    );
    // agents[0] is main; the member is agents[1].
    expect(agents[1]?.glyph).toBe("⚙");
  });
});

describe("deriveWorkers", () => {
  it("maps fleet workers to light agent nodes with distinct colors", () => {
    const workers = deriveWorkers(
      snapshot({
        team: [member({ id: "a" })],
        workers: [
          { task: "scan repo", role: "scout", state: "running" },
          { task: "write tests", state: "done" },
        ],
      }),
    );
    expect(workers).toHaveLength(2);
    expect(workers[0]?.kind).toBe("worker");
    expect(workers[0]?.name).toBe("scout");
    expect(workers[0]?.state).toBe("running");
    expect(workers[1]?.name).toBe("worker"); // no role → fallback
    expect(workers[0]?.colorVar).not.toBe(workers[1]?.colorVar);
  });
});

describe("agentCounts", () => {
  it("uses the authoritative activeAgents for running and the full roster for total", () => {
    const c = agentCounts(
      snapshot({
        team: [member({ id: "a" }), member({ id: "b" })],
        workers: [{ task: "t", state: "running" }],
        fleet: { active: 3, round: 1 },
        activeAgents: 5,
      }),
    );
    expect(c.running).toBe(5); // server value, verbatim
    expect(c.total).toBe(7); // 1 main + 2 team + 1 worker + 3 fleet
  });

  it("does not collapse to 1/1 during parallel-autonomy with an empty team", () => {
    const c = agentCounts(
      snapshot({ team: [], fleet: { active: 4, round: 2 }, activeAgents: 5 }),
    );
    expect(c.running).toBe(5);
    expect(c.total).toBe(5); // 1 main + 4 fleet
  });
});

describe("shareOfWork", () => {
  it("is relative to the busiest peer by tokens", () => {
    // peers[0] is the synthesized main (0 tokens here); members follow.
    const peers = deriveAgents(
      snapshot({
        team: [
          member({ id: "a", tokenCount: 5000 }),
          member({ id: "b", tokenCount: 10000 }),
        ],
      }),
    );
    expect(shareOfWork(peers[1] as never, peers)).toBe(50);
    expect(shareOfWork(peers[2] as never, peers)).toBe(100);
  });
});

describe("computeKpis", () => {
  it("aggregates only live sessions from the authoritative counts", () => {
    const live = liveEntry(
      snapshot({
        sessionId: "s1",
        tokens: { in: 1000, out: 2000, ctx: 0 },
        main: { toolUseCount: 3, recentActivities: [] },
        team: [
          member({ id: "a", state: "running", toolUseCount: 10 }),
          member({ id: "b", state: "done", toolUseCount: 4 }),
        ],
        activeAgents: 1, // one running member; main idle
      }),
    );
    const lost: CliSessionEntry = {
      ...liveEntry(snapshot({ sessionId: "s2" })),
      connection: "lost",
    };
    const kpis = computeKpis([live, lost]);
    expect(kpis.sessions).toBe(1);
    expect(kpis.tokens).toBe(3000);
    expect(kpis.agentsTotal).toBe(3); // 1 main + 2 members
    expect(kpis.agentsRunning).toBe(1); // = activeAgents
    expect(kpis.tools).toBe(17); // main 3 + members 10 + 4
  });
});

describe("sessionActivity", () => {
  it("reports the concrete tool first", () => {
    expect(sessionActivity(liveEntry(snapshot({ activeTool: "read" })))).toBe(
      "⚙ read",
    );
  });

  it("falls back to a running autonomy goal, then status, then idle", () => {
    expect(
      sessionActivity(
        liveEntry(
          snapshot({
            status: "thinking",
            autonomy: {
              state: "running",
              mode: "eternal",
              goal: "ship the flyout",
              step: 1,
              phases: [],
              team: [],
            },
          }),
        ),
      ),
    ).toBe("ship the flyout");
    expect(sessionActivity(liveEntry(snapshot({ status: "thinking" })))).toBe(
      "thinking…",
    );
    expect(sessionActivity(liveEntry(snapshot()))).toBe("idle");
  });

  it("surfaces connection state over any snapshot", () => {
    const lost: CliSessionEntry = {
      ...liveEntry(snapshot({ status: "tool", activeTool: "bash" })),
      connection: "lost",
    };
    expect(sessionActivity(lost)).toBe("connection lost");
    const connecting: CliSessionEntry = {
      info: liveEntry(snapshot()).info,
      connection: "connecting",
      feed: [],
    };
    expect(sessionActivity(connecting)).toBe("connecting…");
  });
});

describe("sortSessionEntries", () => {
  it("orders busy sessions first, then most-recently-started", () => {
    const idle = liveEntry(
      snapshot({ sessionId: "idle", startedAt: 3000, activeAgents: 0 }),
    );
    const busyOld = liveEntry(
      snapshot({ sessionId: "busyOld", startedAt: 1000, activeAgents: 2 }),
    );
    const busyNew = liveEntry(
      snapshot({ sessionId: "busyNew", startedAt: 2000, activeAgents: 1 }),
    );
    const order = sortSessionEntries([idle, busyOld, busyNew]).map(
      (e) => e.info.sessionId,
    );
    expect(order).toEqual(["busyNew", "busyOld", "idle"]);
  });

  it("does not mutate the input array", () => {
    const a = liveEntry(snapshot({ sessionId: "a", startedAt: 1 }));
    const b = liveEntry(snapshot({ sessionId: "b", startedAt: 2 }));
    const input = [a, b];
    sortSessionEntries(input);
    expect(input[0]).toBe(a); // original order untouched
  });
});

describe("phaseProgress", () => {
  const phases = [
    { id: "p1", title: "scope", done: "spec written" },
    { id: "p2", title: "build", done: "code compiles", parallel: true },
    { id: "p3", title: "verify", done: "tests pass" },
  ];
  it("marks phases done / current / pending from the step index", () => {
    expect(phaseProgress(phases, 1).map((p) => p.status)).toEqual([
      "done",
      "current",
      "pending",
    ]);
  });
  it("treats a step past the end as all done", () => {
    expect(phaseProgress(phases, 3).every((p) => p.status === "done")).toBe(
      true,
    );
  });
  it("carries the phase through untouched", () => {
    expect(phaseProgress(phases, 0)[1]?.phase.parallel).toBe(true);
  });
});

describe("formatters", () => {
  it("compact", () => {
    expect(compact(950)).toBe("950");
    expect(compact(1200)).toBe("1.2k");
    expect(compact(15000)).toBe("15k");
    expect(compact(1_300_000)).toBe("1.3M");
  });
  it("fmtElapsed", () => {
    expect(fmtElapsed(45)).toBe("45s");
    expect(fmtElapsed(125)).toBe("2m05s");
  });
});
