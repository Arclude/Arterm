import { describe, expect, it } from "vitest";
import type { CliSessionEntry } from "../store/cliStatusStore";
import type { StampedEvent, StatusSnapshot, TeamMemberStatus } from "../types";
import {
  buildGlobalTopology,
  buildSessionTopology,
  layoutTidyTree,
} from "./topology";

/** A stamped `team_message` blackboard posting for the feed. */
function msg(seq: number, over: Record<string, unknown>): StampedEvent {
  return { seq, ts: seq * 1000, type: "team_message", ...over };
}

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

function liveEntry(
  snap: StatusSnapshot,
  over: Partial<CliSessionEntry> = {},
): CliSessionEntry {
  return {
    info: {
      v: 1,
      pid: 1,
      sessionId: snap.sessionId,
      port: 1,
      token: "t",
      cwd: `/proj/${snap.sessionId}`,
      startedAt: snap.startedAt,
    },
    snapshot: snap,
    connection: "live",
    feed: [],
    ...over,
  };
}

describe("buildSessionTopology", () => {
  it("wires every member and worker as a child of main, animating active ones", () => {
    const { nodes, edges } = buildSessionTopology(
      snapshot({
        team: [
          member({ id: "a", name: "@a", state: "running" }),
          member({ id: "b", name: "@b", state: "done" }),
        ],
        workers: [{ task: "scan", role: "scout", state: "running" }],
      }),
    );
    expect(nodes.map((n) => n.id)).toEqual(["main", "a", "b", "worker-3"]);
    expect(edges).toHaveLength(3);
    // Every edge originates at main.
    expect(edges.every((e) => e.source === "main")).toBe(true);
    const byTarget = new Map(edges.map((e) => [e.target, e]));
    expect(byTarget.get("a")?.animated).toBe(true); // running
    expect(byTarget.get("b")?.animated).toBe(false); // done
    expect(byTarget.get("worker-3")?.animated).toBe(true); // running
  });

  it("is a lone main node with no edges for a solo session", () => {
    const { nodes, edges } = buildSessionTopology(snapshot());
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.kind).toBe("main");
    expect(edges).toHaveLength(0);
  });

  it("adds a directed member→member blackboard edge from the feed, aggregating repeats", () => {
    const feed: StampedEvent[] = [
      msg(1, {
        round: 1,
        from: "a",
        fromName: "@a",
        to: "b",
        toName: "@b",
        kind: "message",
        text: "ping",
      }),
      msg(2, {
        round: 1,
        from: "a",
        fromName: "@a",
        to: "b",
        toName: "@b",
        kind: "message",
        text: "again",
      }),
    ];
    const { edges } = buildSessionTopology(
      snapshot({
        team: [
          member({ id: "a", name: "@a" }),
          member({ id: "b", name: "@b" }),
        ],
      }),
      feed,
    );
    // Tree edges keep their kind; the message edge is layered on top.
    expect(edges.filter((e) => e.kind === "tree")).toHaveLength(2);
    const msgEdges = edges.filter((e) => e.kind === "message");
    expect(msgEdges).toHaveLength(1);
    const e = msgEdges[0];
    expect(e?.source).toBe("a");
    expect(e?.target).toBe("b");
    expect(e?.directed).toBe(true);
    expect(e?.count).toBe(2);
    expect(e?.latestText).toBe("again"); // newest by seq
    expect(e?.round).toBe(1); // carried for the edge tooltip / panel
    expect(e?.id).toBe("msg:a->b");
  });

  it("collapses a member's broadcasts and results onto one faint member→main edge", () => {
    const feed: StampedEvent[] = [
      msg(1, {
        round: 1,
        from: "a",
        fromName: "@a",
        kind: "message",
        text: "hi all",
      }),
      msg(2, {
        round: 1,
        from: "a",
        fromName: "@a",
        kind: "result",
        text: "done",
      }),
    ];
    const { edges } = buildSessionTopology(
      snapshot({ team: [member({ id: "a", name: "@a" })] }),
      feed,
    );
    const msgEdges = edges.filter((e) => e.kind === "message");
    expect(msgEdges).toHaveLength(1);
    expect(msgEdges[0]?.source).toBe("a");
    expect(msgEdges[0]?.target).toBe("main"); // the hub
    expect(msgEdges[0]?.directed).toBe(false);
    expect(msgEdges[0]?.count).toBe(2);
  });

  it("maps a leader sender to main and drops notes about vanished members", () => {
    const feed: StampedEvent[] = [
      msg(1, {
        round: 1,
        from: "leader",
        fromName: "leader",
        to: "a",
        toName: "@a",
        kind: "message",
        text: "do X",
      }),
      msg(2, {
        round: 1,
        from: "a",
        fromName: "@a",
        to: "ghost",
        toName: "@ghost",
        kind: "message",
        text: "?",
      }),
    ];
    const { edges } = buildSessionTopology(
      snapshot({ team: [member({ id: "a", name: "@a" })] }),
      feed,
    );
    const msgEdges = edges.filter((e) => e.kind === "message");
    // leader→a kept (leader maps to main); a→ghost dropped (no such node).
    expect(msgEdges).toHaveLength(1);
    expect(msgEdges[0]?.source).toBe("main");
    expect(msgEdges[0]?.target).toBe("a");
    expect(msgEdges[0]?.directed).toBe(true);
  });
});

describe("buildGlobalTopology", () => {
  it("emits a namespaced session → main → members/workers tree per live session", () => {
    const a = liveEntry(
      snapshot({
        sessionId: "A",
        team: [member({ id: "r", state: "running" })],
        activeAgents: 1,
      }),
    );
    const b = liveEntry(snapshot({ sessionId: "B" })); // solo, idle
    const lost = liveEntry(snapshot({ sessionId: "C" }), {
      connection: "lost",
    });
    const { nodes, edges } = buildGlobalTopology([a, b, lost]);

    const ids = nodes.map((n) => n.id);
    expect(ids).toContain("s:A");
    expect(ids).toContain("s:B");
    expect(ids).not.toContain("s:C"); // lost session skipped
    // agent ids are namespaced so `main` doesn't collide across sessions
    expect(ids).toContain("A:main");
    expect(ids).toContain("A:r");
    expect(ids).toContain("B:main");

    const edgeKeys = edges.map((e) => `${e.source}>${e.target}`);
    expect(edgeKeys).toContain("s:A>A:main");
    expect(edgeKeys).toContain("A:main>A:r");
    expect(edgeKeys).toContain("s:B>B:main");

    // session→main animates only while the session is busy
    expect(edges.find((e) => e.id === "s:A->A:main")?.animated).toBe(true);
    expect(edges.find((e) => e.id === "s:B->B:main")?.animated).toBe(false);

    // the session node carries its entry; agent nodes carry the plain id
    const sessionNode = nodes.find((n) => n.id === "s:A");
    expect(sessionNode?.kind).toBe("session");
    expect(sessionNode?.entry?.info.sessionId).toBe("A");
    expect(nodes.find((n) => n.id === "A:r")?.agentId).toBe("r");
  });

  it("namespaces blackboard message edges per session from each entry's feed", () => {
    const feed: StampedEvent[] = [
      msg(1, {
        round: 1,
        from: "a",
        fromName: "@a",
        to: "b",
        toName: "@b",
        kind: "message",
        text: "hi",
      }),
    ];
    const entry = liveEntry(
      snapshot({
        sessionId: "A",
        team: [member({ id: "a" }), member({ id: "b" })],
      }),
      { feed },
    );
    const { edges } = buildGlobalTopology([entry]);
    const msgEdges = edges.filter((e) => e.kind === "message");
    expect(msgEdges).toHaveLength(1);
    expect(msgEdges[0]?.source).toBe("A:a");
    expect(msgEdges[0]?.target).toBe("A:b");
    expect(msgEdges[0]?.id).toBe("msg:A:a->A:b");
    expect(msgEdges[0]?.directed).toBe(true);
  });

  it("lays out the global tree in session → main → agent columns", () => {
    const { nodes, edges } = buildGlobalTopology([
      liveEntry(snapshot({ sessionId: "A", team: [member({ id: "r" })] })),
    ]);
    const pos = layoutTidyTree(
      nodes.map((n) => ({ id: n.id })),
      edges,
      { colGap: 100, rowGap: 40 },
    );
    expect(pos.get("s:A")?.x).toBe(0);
    expect(pos.get("A:main")?.x).toBe(100);
    expect(pos.get("A:r")?.x).toBe(200);
  });
});

describe("layoutTidyTree", () => {
  it("columns by depth and centers a parent over its children", () => {
    const pos = layoutTidyTree(
      [{ id: "main" }, { id: "a" }, { id: "b" }],
      [
        { source: "main", target: "a" },
        { source: "main", target: "b" },
      ],
      { colGap: 240, rowGap: 88 },
    );
    expect(pos.get("a")).toEqual({ x: 240, y: 0 });
    expect(pos.get("b")).toEqual({ x: 240, y: 88 });
    // main centers over the [0, 88] span → 44, at column 0.
    expect(pos.get("main")).toEqual({ x: 0, y: 44 });
  });

  it("places a solo root at the origin", () => {
    const pos = layoutTidyTree([{ id: "main" }], []);
    expect(pos.get("main")).toEqual({ x: 0, y: 0 });
  });

  it("handles a 3-level tree (session → main → members)", () => {
    const pos = layoutTidyTree(
      [{ id: "sess" }, { id: "main" }, { id: "a" }, { id: "b" }],
      [
        { source: "sess", target: "main" },
        { source: "main", target: "a" },
        { source: "main", target: "b" },
      ],
      { colGap: 100, rowGap: 40 },
    );
    expect(pos.get("a")).toEqual({ x: 200, y: 0 });
    expect(pos.get("b")).toEqual({ x: 200, y: 40 });
    expect(pos.get("main")).toEqual({ x: 100, y: 20 });
    expect(pos.get("sess")).toEqual({ x: 0, y: 20 });
  });

  it("stacks orphans stranded by a cycle without throwing", () => {
    const pos = layoutTidyTree(
      [{ id: "x" }, { id: "y" }],
      [
        { source: "x", target: "y" },
        { source: "y", target: "x" }, // cycle: neither is a root
      ],
      { colGap: 10, rowGap: 10 },
    );
    expect(pos.size).toBe(2);
    expect(pos.has("x")).toBe(true);
    expect(pos.has("y")).toBe(true);
  });
});
