import { beforeEach, describe, expect, it } from "vitest";
import type { CliSessionInfo, StampedEvent, StatusSnapshot } from "../types";
import {
  selectCliBusy,
  selectOnlineSessionCount,
  selectTotalActiveAgents,
  useCliStatusStore,
} from "./cliStatusStore";

function info(
  sessionId: string,
  over: Partial<CliSessionInfo> = {},
): CliSessionInfo {
  return {
    v: 1,
    pid: 1000,
    sessionId,
    port: 50000,
    token: "tok",
    cwd: "/proj",
    startedAt: 1,
    ...over,
  };
}

function snapshot(
  sessionId: string,
  over: Partial<StatusSnapshot> = {},
): StatusSnapshot {
  return {
    v: 1,
    pid: 1000,
    sessionId,
    cwd: "/proj",
    startedAt: 1,
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

function ev(seq: number): StampedEvent {
  return { seq, ts: seq, type: "tool_call", tool: "read" };
}

const store = () => useCliStatusStore.getState();

describe("cliStatusStore", () => {
  beforeEach(() => {
    useCliStatusStore.setState({ sessions: {}, selectedSessionId: null });
  });

  it("upsertInfo creates then refreshes without dropping snapshot/feed", () => {
    store().upsertInfo(info("a"));
    expect(store().sessions.a?.connection).toBe("connecting");

    store().setSnapshot("a", snapshot("a", { rounds: 3 }), [ev(1)]);
    store().upsertInfo(info("a", { model: "new" }));

    const entry = store().sessions.a;
    expect(entry?.info.model).toBe("new");
    expect(entry?.snapshot?.rounds).toBe(3);
    expect(entry?.feed).toHaveLength(1);
  });

  it("setSnapshot only reseeds feed when events are provided", () => {
    store().upsertInfo(info("a"));
    store().setSnapshot("a", snapshot("a"), [ev(1), ev(2)]);
    store().setSnapshot("a", snapshot("a", { rounds: 9 }));
    expect(store().sessions.a?.feed).toHaveLength(2);
    expect(store().sessions.a?.snapshot?.rounds).toBe(9);
  });

  it("appendEvent caps the feed at 200", () => {
    store().upsertInfo(info("a"));
    for (let i = 1; i <= 250; i++) store().appendEvent("a", ev(i));
    const feed = store().sessions.a?.feed ?? [];
    expect(feed).toHaveLength(200);
    expect(feed[0]?.seq).toBe(51); // oldest 50 dropped
    expect(feed[feed.length - 1]?.seq).toBe(250);
  });

  it("markUnsupported flags the session", () => {
    store().upsertInfo(info("a", { v: 2 }));
    store().markUnsupported("a");
    expect(store().sessions.a?.unsupported).toBe(true);
  });

  it("remove deletes the session", () => {
    store().upsertInfo(info("a"));
    store().remove("a");
    expect(store().sessions.a).toBeUndefined();
  });

  it("selectSession sets and clears the shared focus", () => {
    store().selectSession("a");
    expect(store().selectedSessionId).toBe("a");
    store().selectSession(null);
    expect(store().selectedSessionId).toBeNull();
  });

  it("remove clears the focus only when it targets the selected session", () => {
    store().upsertInfo(info("a"));
    store().upsertInfo(info("b"));
    store().selectSession("a");
    store().remove("b"); // unrelated removal keeps the focus
    expect(store().selectedSessionId).toBe("a");
    store().remove("a"); // removing the focused session clears it
    expect(store().selectedSessionId).toBeNull();
  });

  it("selectTotalActiveAgents sums only live sessions", () => {
    store().upsertInfo(info("a"));
    store().upsertInfo(info("b"));
    store().setSnapshot("a", snapshot("a", { activeAgents: 2 }));
    store().setSnapshot("b", snapshot("b", { activeAgents: 3 }));
    store().setConnection("a", "live");
    // b stays "connecting" — excluded from the badge total.
    expect(selectTotalActiveAgents(useCliStatusStore.getState())).toBe(2);

    store().setConnection("b", "live");
    expect(selectTotalActiveAgents(useCliStatusStore.getState())).toBe(5);

    store().setConnection("a", "lost");
    expect(selectTotalActiveAgents(useCliStatusStore.getState())).toBe(3);
  });

  it("selectOnlineSessionCount counts everything but lost connections", () => {
    store().upsertInfo(info("a")); // connecting
    store().upsertInfo(info("b"));
    store().setConnection("b", "live");
    store().upsertInfo(info("c"));
    store().setConnection("c", "lost");
    expect(selectOnlineSessionCount(useCliStatusStore.getState())).toBe(2);
  });

  it("selectCliBusy is true only when a live session is actively working", () => {
    store().upsertInfo(info("a"));
    store().setSnapshot("a", snapshot("a", { status: "idle" }));
    store().setConnection("a", "live");
    expect(selectCliBusy(useCliStatusStore.getState())).toBe(false);

    // A thinking session flips it on...
    store().setSnapshot("a", snapshot("a", { status: "thinking" }));
    expect(selectCliBusy(useCliStatusStore.getState())).toBe(true);

    // ...but only while the connection is live.
    store().setConnection("a", "lost");
    expect(selectCliBusy(useCliStatusStore.getState())).toBe(false);

    // Sub-agents count as busy even when the top-level status is idle.
    store().upsertInfo(info("b"));
    store().setSnapshot(
      "b",
      snapshot("b", { status: "idle", activeAgents: 2 }),
    );
    store().setConnection("b", "live");
    expect(selectCliBusy(useCliStatusStore.getState())).toBe(true);
  });
});
