import { describe, expect, it } from "vitest";
import { EMPTY_GROUPS } from "@/modules/tabs/lib/editorGroups";
import type { Tab } from "@/modules/tabs/lib/useTabs";
import type { PaneNode } from "@/modules/terminal/lib/panes";
import {
  buildInitialState,
  buildSnapshot,
  parseSnapshot,
  type SessionSnapshotV1,
} from "./session";

const leaf = (id: number, cwd?: string): PaneNode => ({
  kind: "leaf",
  id,
  cwd,
});

function sampleTabs(): Tab[] {
  return [
    {
      id: 1,
      kind: "terminal",
      title: "shell",
      cwd: "C:/work",
      paneTree: {
        kind: "split",
        id: 10,
        dir: "row",
        children: [leaf(2, "C:/work"), leaf(11, "C:/other")],
      },
      activeLeafId: 11,
      customTitle: "build",
    },
    {
      id: 3,
      kind: "terminal",
      title: "private",
      paneTree: leaf(4),
      activeLeafId: 4,
      private: true,
    },
    {
      id: 5,
      kind: "editor",
      title: "a.ts",
      path: "C:/work/a.ts",
      dirty: true,
      preview: true,
    },
    {
      id: 6,
      kind: "markdown",
      title: "readme",
      path: "C:/work/README.md",
    },
    {
      id: 7,
      kind: "git-history",
      title: "History",
      repoRoot: "C:/work",
    },
  ];
}

describe("buildSnapshot", () => {
  it("keeps terminals and editors, drops private and transient tabs", () => {
    const snap = buildSnapshot(sampleTabs(), 1, EMPTY_GROUPS);
    expect(snap.tabs.map((t) => t.id)).toEqual([1, 5]);
    expect(snap.tabs[0]).toMatchObject({
      kind: "terminal",
      customTitle: "build",
      activeLeafId: 11,
    });
    expect(snap.tabs[1]).toEqual({
      kind: "editor",
      id: 5,
      title: "a.ts",
      path: "C:/work/a.ts",
    });
  });

  it("nulls activeTabId when the active tab was not saved", () => {
    expect(buildSnapshot(sampleTabs(), 3, EMPTY_GROUPS).activeTabId).toBeNull();
    expect(buildSnapshot(sampleTabs(), 1, EMPTY_GROUPS).activeTabId).toBe(1);
  });

  it("nulls editorGroups when no layout exists", () => {
    expect(
      buildSnapshot(sampleTabs(), 1, EMPTY_GROUPS).editorGroups,
    ).toBeNull();
  });

  it("round-trips through parseSnapshot", () => {
    const snap = buildSnapshot(sampleTabs(), 1, {
      layout: leaf(100),
      groups: { 100: { tabIds: [5], activeTabId: 5 } },
      activeGroupId: 100,
    });
    expect(parseSnapshot(JSON.parse(JSON.stringify(snap)))).toEqual(snap);
  });
});

describe("parseSnapshot", () => {
  const valid: SessionSnapshotV1 = {
    version: 1,
    savedAt: 123,
    tabs: [
      {
        kind: "terminal",
        id: 1,
        title: "shell",
        paneTree: leaf(2),
        activeLeafId: 2,
      },
      { kind: "editor", id: 3, title: "a.ts", path: "C:/a.ts" },
    ],
    activeTabId: 1,
    editorGroups: null,
  };

  it("accepts a valid snapshot", () => {
    expect(parseSnapshot(valid)).toEqual(valid);
  });

  it("rejects junk, wrong versions and malformed shapes", () => {
    expect(parseSnapshot(null)).toBeNull();
    expect(parseSnapshot("{}")).toBeNull();
    expect(parseSnapshot({ ...valid, version: 2 })).toBeNull();
    expect(
      parseSnapshot({ ...valid, tabs: [{ kind: "editor", id: 1 }] }),
    ).toBeNull();
    expect(parseSnapshot({ ...valid, activeTabId: "1" })).toBeNull();
    expect(
      parseSnapshot({
        ...valid,
        tabs: [
          {
            kind: "terminal",
            id: 1,
            title: "x",
            activeLeafId: 2,
            paneTree: {
              kind: "split",
              id: 9,
              dir: "diag",
              children: [leaf(2)],
            },
          },
        ],
      }),
    ).toBeNull();
    expect(
      parseSnapshot({
        ...valid,
        editorGroups: {
          layout: leaf(1),
          groups: { 1: { tabIds: ["x"], activeTabId: null } },
          activeGroupId: 1,
        },
      }),
    ).toBeNull();
  });
});

describe("buildInitialState", () => {
  it("returns the classic default when no snapshot exists", () => {
    const s = buildInitialState({ cwd: "C:/here" }, null);
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0]).toMatchObject({
      id: 1,
      kind: "terminal",
      cwd: "C:/here",
    });
    expect(s.activeId).toBe(1);
    expect(s.editorGroups).toEqual(EMPTY_GROUPS);
    expect(s.nextId).toBe(3);
  });

  it("falls back to the default when the snapshot has no tabs", () => {
    const s = buildInitialState(undefined, {
      version: 1,
      savedAt: 0,
      tabs: [],
      activeTabId: null,
      editorGroups: null,
    });
    expect(s.tabs).toHaveLength(1);
    expect(s.nextId).toBe(3);
  });

  it("materializes tabs and seeds the id counter past every used id", () => {
    const s = buildInitialState(undefined, {
      version: 1,
      savedAt: 0,
      tabs: [
        {
          kind: "terminal",
          id: 4,
          title: "shell",
          paneTree: {
            kind: "split",
            id: 30,
            dir: "col",
            children: [leaf(5), leaf(12)],
          },
          activeLeafId: 12,
        },
        { kind: "editor", id: 7, title: "a.ts", path: "C:/a.ts" },
      ],
      activeTabId: 7,
      editorGroups: {
        layout: leaf(40),
        groups: { 40: { tabIds: [7], activeTabId: 7 } },
        activeGroupId: 40,
      },
    });
    expect(s.tabs.map((t) => t.id)).toEqual([4, 7]);
    expect(s.tabs[1]).toMatchObject({ dirty: false, preview: false });
    expect(s.activeId).toBe(7);
    expect(s.editorGroups.activeGroupId).toBe(40);
    expect(s.nextId).toBe(41); // max(4, 30, 5, 12, 7, 40) + 1
  });

  it("repairs a stale activeTabId and activeLeafId", () => {
    const s = buildInitialState(undefined, {
      version: 1,
      savedAt: 0,
      tabs: [
        {
          kind: "terminal",
          id: 1,
          title: "shell",
          paneTree: leaf(2),
          activeLeafId: 99,
        },
      ],
      activeTabId: 42,
      editorGroups: null,
    });
    expect(s.activeId).toBe(1);
    const term = s.tabs[0];
    expect(term.kind === "terminal" && term.activeLeafId).toBe(2);
  });

  it("drops editor groups that reference unsaved tabs", () => {
    const s = buildInitialState(undefined, {
      version: 1,
      savedAt: 0,
      tabs: [{ kind: "editor", id: 5, title: "a.ts", path: "C:/a.ts" }],
      activeTabId: 5,
      editorGroups: {
        layout: {
          kind: "split",
          id: 200,
          dir: "row",
          children: [leaf(100), leaf(101)],
        },
        groups: {
          100: { tabIds: [5], activeTabId: 5 },
          101: { tabIds: [99], activeTabId: 99 },
        },
        activeGroupId: 101,
      },
    });
    expect(s.editorGroups.layout).toEqual(leaf(100));
    expect(s.editorGroups.groups).toEqual({
      100: { tabIds: [5], activeTabId: 5 },
    });
    expect(s.editorGroups.activeGroupId).toBe(100);
  });
});
