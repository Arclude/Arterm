import { describe, expect, it } from "vitest";
import { leafIds } from "@/modules/terminal/lib/panes";
import {
  activateTabInGroup,
  EMPTY_GROUPS,
  groupOf,
  moveTab,
  placeEditor,
  removeEditor,
  splitActiveGroup,
} from "./editorGroups";

// Open three editors into the first (bootstrapped) group.
function seed() {
  let s = placeEditor(EMPTY_GROUPS, 10, 100);
  s = placeEditor(s, 11, 0);
  s = placeEditor(s, 12, 0);
  return s;
}

describe("placeEditor", () => {
  it("bootstraps the first group", () => {
    const s = placeEditor(EMPTY_GROUPS, 10, 100);
    expect(s.activeGroupId).toBe(100);
    expect(leafIds(s.layout!)).toEqual([100]);
    expect(s.groups[100]).toEqual({ tabIds: [10], activeTabId: 10 });
  });

  it("appends to the active group and activates", () => {
    const s = seed();
    expect(s.groups[100].tabIds).toEqual([10, 11, 12]);
    expect(s.groups[100].activeTabId).toBe(12);
  });
});

describe("splitActiveGroup", () => {
  it("creates a second group with the moved tab and focuses it", () => {
    const s = seed();
    const split = splitActiveGroup(s, "row", 200, 201, 99);
    expect(s.activeGroupId).toBe(100); // original untouched
    expect(split.activeGroupId).toBe(201);
    expect(leafIds(split.layout!).sort()).toEqual([100, 201]);
    expect(split.groups[201]).toEqual({ tabIds: [99], activeTabId: 99 });
    expect(split.groups[100].tabIds).toEqual([10, 11, 12]);
  });
});

describe("removeEditor", () => {
  it("removes a tab and keeps the group", () => {
    const s = removeEditor(seed(), 11);
    expect(s.groups[100].tabIds).toEqual([10, 12]);
  });

  it("picks a neighbor when the active tab is removed", () => {
    const s = removeEditor(seed(), 12); // 12 was active
    expect(s.groups[100].activeTabId).toBe(11);
  });

  it("collapses an emptied group and refocuses a sibling", () => {
    let s = seed();
    s = splitActiveGroup(s, "row", 200, 201, 99); // group 201 active, holds [99]
    s = removeEditor(s, 99); // empties 201
    expect(s.groups[201]).toBeUndefined();
    expect(leafIds(s.layout!)).toEqual([100]);
    expect(s.activeGroupId).toBe(100);
  });

  it("clears layout when the last editor closes", () => {
    let s = placeEditor(EMPTY_GROUPS, 10, 100);
    s = removeEditor(s, 10);
    expect(s.layout).toBeNull();
    expect(s.activeGroupId).toBeNull();
  });
});

describe("moveTab", () => {
  it("reorders within a group", () => {
    const s = moveTab(seed(), 12, 100, 0);
    expect(s.groups[100].tabIds).toEqual([12, 10, 11]);
  });

  it("moves a tab across groups", () => {
    let s = seed();
    s = splitActiveGroup(s, "row", 200, 201, 99); // 201:[99]
    s = moveTab(s, 10, 201, 1); // move 10 from 100 to 201 at index 1
    expect(groupOf(s, 10)).toBe(201);
    expect(s.groups[201].tabIds).toEqual([99, 10]);
    expect(s.groups[100].tabIds).toEqual([11, 12]);
    expect(s.activeGroupId).toBe(201);
  });

  it("collapses the source group if the move empties it", () => {
    let s = placeEditor(EMPTY_GROUPS, 10, 100);
    s = splitActiveGroup(s, "row", 200, 201, 99); // 100:[10], 201:[99]
    s = moveTab(s, 10, 201, 0); // empties group 100
    expect(s.groups[100]).toBeUndefined();
    expect(leafIds(s.layout!)).toEqual([201]);
    expect(s.groups[201].tabIds).toEqual([10, 99]);
  });
});

describe("activateTabInGroup", () => {
  it("focuses the group and sets its active tab", () => {
    let s = seed();
    s = splitActiveGroup(s, "row", 200, 201, 99);
    s = activateTabInGroup(s, 100, 10);
    expect(s.activeGroupId).toBe(100);
    expect(s.groups[100].activeTabId).toBe(10);
  });
});
