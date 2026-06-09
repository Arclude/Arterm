import {
  leafIds,
  type PaneNode,
  removeLeaf,
  siblingLeafOf,
  type SplitDir,
  splitLeaf,
} from "@/modules/terminal/lib/panes";

// VS Code-style editor groups. The grid layout reuses the terminal pane tree
// (`panes.ts`): each leaf id IS a group id, so all the battle-tested
// split/remove/collapse logic is shared. Each group owns an ordered list of
// editor tab ids plus its own active tab. Editor tabs still live in the flat
// `tabs` array (for their data); groups only track placement and focus.

export type EditorGroup = {
  /** Editor tab ids in this group, in strip order. */
  tabIds: number[];
  activeTabId: number | null;
};

export type EditorGroupsState = {
  /** Grid tree; leaf ids === group ids. `null` when no editors are open. */
  layout: PaneNode | null;
  groups: Record<number, EditorGroup>;
  activeGroupId: number | null;
};

export const EMPTY_GROUPS: EditorGroupsState = {
  layout: null,
  groups: {},
  activeGroupId: null,
};

/** Group id that currently holds `tabId`, or null. */
export function groupOf(
  state: EditorGroupsState,
  tabId: number,
): number | null {
  for (const [gid, g] of Object.entries(state.groups)) {
    if (g.tabIds.includes(tabId)) return Number(gid);
  }
  return null;
}

export function activeEditorTabId(state: EditorGroupsState): number | null {
  if (state.activeGroupId == null) return null;
  return state.groups[state.activeGroupId]?.activeTabId ?? null;
}

function withGroup(
  state: EditorGroupsState,
  gid: number,
  patch: Partial<EditorGroup>,
): EditorGroupsState {
  return {
    ...state,
    groups: { ...state.groups, [gid]: { ...state.groups[gid], ...patch } },
  };
}

/** Place a newly opened editor into the active group, creating the first group
 * if none exist yet. `freshGroupId` is consumed only when bootstrapping. */
export function placeEditor(
  state: EditorGroupsState,
  tabId: number,
  freshGroupId: number,
): EditorGroupsState {
  if (state.layout == null || state.activeGroupId == null) {
    return {
      layout: { kind: "leaf", id: freshGroupId },
      groups: { [freshGroupId]: { tabIds: [tabId], activeTabId: tabId } },
      activeGroupId: freshGroupId,
    };
  }
  const gid = state.activeGroupId;
  const g = state.groups[gid];
  if (g.tabIds.includes(tabId))
    return withGroup(state, gid, { activeTabId: tabId });
  return withGroup(state, gid, {
    tabIds: [...g.tabIds, tabId],
    activeTabId: tabId,
  });
}

/** Swap `oldId` for `newId` in place wherever it appears, preserving the tab's
 * position and active status. Used when a preview tab is replaced by another
 * file (the flat tab gets a fresh id). */
export function replaceEditor(
  state: EditorGroupsState,
  oldId: number,
  newId: number,
): EditorGroupsState {
  const gid = groupOf(state, oldId);
  if (gid == null) return state;
  const g = state.groups[gid];
  return {
    ...withGroup(state, gid, {
      tabIds: g.tabIds.map((x) => (x === oldId ? newId : x)),
      activeTabId: g.activeTabId === oldId ? newId : g.activeTabId,
    }),
    activeGroupId: gid,
  };
}

/** Focus the group holding `tabId` and make it that group's active tab. */
export function activateEditor(
  state: EditorGroupsState,
  tabId: number,
): EditorGroupsState {
  const gid = groupOf(state, tabId);
  if (gid == null) return state;
  return {
    ...withGroup(state, gid, { activeTabId: tabId }),
    activeGroupId: gid,
  };
}

/** Make `tabId` active within `gid` and focus that group. */
export function activateTabInGroup(
  state: EditorGroupsState,
  gid: number,
  tabId: number,
): EditorGroupsState {
  if (!state.groups[gid]?.tabIds.includes(tabId)) return state;
  return {
    ...withGroup(state, gid, { activeTabId: tabId }),
    activeGroupId: gid,
  };
}

export function focusGroup(
  state: EditorGroupsState,
  gid: number,
): EditorGroupsState {
  if (!state.groups[gid] || state.activeGroupId === gid) return state;
  return { ...state, activeGroupId: gid };
}

/** Remove an editor tab from its group. Collapses the group (and its layout
 * leaf) when it becomes empty, moving focus to a neighbor. */
export function removeEditor(
  state: EditorGroupsState,
  tabId: number,
): EditorGroupsState {
  const gid = groupOf(state, tabId);
  if (gid == null || state.layout == null) return state;
  const g = state.groups[gid];
  const idx = g.tabIds.indexOf(tabId);
  const tabIds = g.tabIds.filter((x) => x !== tabId);

  if (tabIds.length > 0) {
    const activeTabId =
      g.activeTabId === tabId
        ? tabIds[Math.min(idx, tabIds.length - 1)]
        : g.activeTabId;
    return withGroup(state, gid, { tabIds, activeTabId });
  }

  // Group emptied — drop its leaf from the layout and pick a new focus.
  const sibling = siblingLeafOf(state.layout, gid);
  const layout = removeLeaf(state.layout, gid);
  const groups = { ...state.groups };
  delete groups[gid];

  let activeGroupId = state.activeGroupId;
  if (activeGroupId === gid) {
    activeGroupId =
      layout && sibling != null && leafIds(layout).includes(sibling)
        ? sibling
        : layout
          ? (leafIds(layout)[0] ?? null)
          : null;
  }
  return { layout, groups, activeGroupId };
}

/** Split the active group along `dir`, putting `newTabId` (if given) into a new
 * group that becomes active. Caller allocates the ids. */
export function splitActiveGroup(
  state: EditorGroupsState,
  dir: SplitDir,
  newSplitId: number,
  newGroupId: number,
  newTabId: number | null,
): EditorGroupsState {
  if (state.layout == null || state.activeGroupId == null) {
    // No groups yet — nothing to split; treat as a fresh group.
    if (newTabId == null) return state;
    return {
      layout: { kind: "leaf", id: newGroupId },
      groups: { [newGroupId]: { tabIds: [newTabId], activeTabId: newTabId } },
      activeGroupId: newGroupId,
    };
  }
  const layout = splitLeaf(
    state.layout,
    state.activeGroupId,
    newSplitId,
    newGroupId,
    dir,
  );
  return {
    layout,
    groups: {
      ...state.groups,
      [newGroupId]: {
        tabIds: newTabId == null ? [] : [newTabId],
        activeTabId: newTabId,
      },
    },
    activeGroupId: newGroupId,
  };
}

/** Move `tabId` into `toGroupId` at `index` (drag & drop). Removes it from its
 * source group first; if that empties the source, the source leaf collapses.
 * No-op if the tab is dropped onto its own position. */
export function moveTab(
  state: EditorGroupsState,
  tabId: number,
  toGroupId: number,
  index: number,
): EditorGroupsState {
  const from = groupOf(state, tabId);
  if (from == null || !state.groups[toGroupId]) return state;
  if (from === toGroupId) {
    // Reorder within the same group.
    const g = state.groups[toGroupId];
    const without = g.tabIds.filter((x) => x !== tabId);
    const clamped = Math.max(0, Math.min(index, without.length));
    without.splice(clamped, 0, tabId);
    return {
      ...withGroup(state, toGroupId, { tabIds: without, activeTabId: tabId }),
      activeGroupId: toGroupId,
    };
  }

  // Cross-group move: remove from source, then insert into target.
  let next = removeEditor(state, tabId);
  // The target group still exists (we only removed from `from`); but if the
  // source collapsed, layout/active changed — the target group id is stable.
  const tg = next.groups[toGroupId];
  if (!tg) return state;
  const clamped = Math.max(0, Math.min(index, tg.tabIds.length));
  const tabIds = [...tg.tabIds];
  tabIds.splice(clamped, 0, tabId);
  next = {
    ...next,
    groups: {
      ...next.groups,
      [toGroupId]: { tabIds, activeTabId: tabId },
    },
    activeGroupId: toGroupId,
  };
  return next;
}
