import {
  EMPTY_GROUPS,
  sanitizeEditorGroups,
  type EditorGroupsState,
} from "@/modules/tabs/lib/editorGroups";
import type { EditorTab, Tab, TerminalTab } from "@/modules/tabs/lib/useTabs";
import { leafIds, type PaneNode } from "@/modules/terminal/lib/panes";

// Session snapshot: what survives an app restart. Terminals come back as
// fresh shells at their saved cwd (PTY content is gone by nature); editors
// reopen from disk (no hot-exit — dirty content is not preserved). Private
// terminals and transient tabs (preview/markdown/ai-diff/git-*) are never
// saved: the former by design, the latter because they reference state that
// does not outlive the process (chat approvals, repo positions).

export type SavedTerminalTab = {
  kind: "terminal";
  id: number;
  title: string;
  cwd?: string;
  paneTree: PaneNode;
  activeLeafId: number;
  customTitle?: string;
};

export type SavedEditorTab = {
  kind: "editor";
  id: number;
  title: string;
  path: string;
};

export type SessionSnapshotV1 = {
  version: 1;
  savedAt: number;
  tabs: Array<SavedTerminalTab | SavedEditorTab>;
  activeTabId: number | null;
  editorGroups: EditorGroupsState | null;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPaneNode(v: unknown): v is PaneNode {
  if (!isRecord(v) || typeof v.id !== "number") return false;
  if (v.kind === "leaf") {
    return v.cwd === undefined || typeof v.cwd === "string";
  }
  if (v.kind === "split") {
    return (
      (v.dir === "row" || v.dir === "col") &&
      Array.isArray(v.children) &&
      v.children.length > 0 &&
      v.children.every(isPaneNode)
    );
  }
  return false;
}

function isSavedTab(v: unknown): v is SavedTerminalTab | SavedEditorTab {
  if (!isRecord(v) || typeof v.id !== "number" || typeof v.title !== "string")
    return false;
  if (v.kind === "terminal") {
    return (
      (v.cwd === undefined || typeof v.cwd === "string") &&
      (v.customTitle === undefined || typeof v.customTitle === "string") &&
      typeof v.activeLeafId === "number" &&
      isPaneNode(v.paneTree)
    );
  }
  if (v.kind === "editor") {
    return typeof v.path === "string";
  }
  return false;
}

function isEditorGroupsState(v: unknown): v is EditorGroupsState {
  if (!isRecord(v)) return false;
  if (v.layout !== null && !isPaneNode(v.layout)) return false;
  if (v.activeGroupId !== null && typeof v.activeGroupId !== "number")
    return false;
  if (!isRecord(v.groups)) return false;
  return Object.values(v.groups).every(
    (g) =>
      isRecord(g) &&
      Array.isArray(g.tabIds) &&
      g.tabIds.every((id) => typeof id === "number") &&
      (g.activeTabId === null || typeof g.activeTabId === "number"),
  );
}

/** Structural validation of a stored snapshot. Anything off (corrupt JSON,
 * future schema version) yields `null` → the app boots a fresh session. */
export function parseSnapshot(raw: unknown): SessionSnapshotV1 | null {
  if (!isRecord(raw) || raw.version !== 1) return null;
  if (typeof raw.savedAt !== "number") return null;
  if (!Array.isArray(raw.tabs) || !raw.tabs.every(isSavedTab)) return null;
  if (raw.activeTabId !== null && typeof raw.activeTabId !== "number")
    return null;
  if (raw.editorGroups !== null && !isEditorGroupsState(raw.editorGroups))
    return null;
  return raw as SessionSnapshotV1;
}

/** Serialize the restorable subset of the live tab state. */
export function buildSnapshot(
  tabs: readonly Tab[],
  activeId: number,
  editorGroups: EditorGroupsState,
): SessionSnapshotV1 {
  const saved: Array<SavedTerminalTab | SavedEditorTab> = [];
  for (const t of tabs) {
    if (t.kind === "terminal" && !t.private) {
      saved.push({
        kind: "terminal",
        id: t.id,
        title: t.title,
        cwd: t.cwd,
        paneTree: t.paneTree,
        activeLeafId: t.activeLeafId,
        customTitle: t.customTitle,
      });
    } else if (t.kind === "editor") {
      saved.push({ kind: "editor", id: t.id, title: t.title, path: t.path });
    }
  }
  return {
    version: 1,
    savedAt: Date.now(),
    tabs: saved,
    activeTabId: saved.some((t) => t.id === activeId) ? activeId : null,
    editorGroups: editorGroups.layout == null ? null : editorGroups,
  };
}

export type TabsInitialState = {
  tabs: Tab[];
  activeId: number;
  editorGroups: EditorGroupsState;
  nextId: number;
};

// Split nodes carry ids from the same counter as leaves — scan both so the
// reseeded counter can never collide with a restored id.
function maxPaneId(n: PaneNode): number {
  if (n.kind === "leaf") return n.id;
  return Math.max(n.id, ...n.children.map(maxPaneId));
}

/** Initial `useTabs` state: materialized from a saved session when one
 * exists, otherwise the classic single-terminal default. */
export function buildInitialState(
  initial?: Partial<TerminalTab>,
  restored?: SessionSnapshotV1 | null,
): TabsInitialState {
  const tabs: Tab[] = [];
  for (const t of restored?.tabs ?? []) {
    if (t.kind === "terminal") {
      const leaves = leafIds(t.paneTree);
      tabs.push({
        id: t.id,
        kind: "terminal",
        title: t.title,
        cwd: t.cwd,
        paneTree: t.paneTree,
        activeLeafId: leaves.includes(t.activeLeafId)
          ? t.activeLeafId
          : leaves[0],
        ...(t.customTitle !== undefined && { customTitle: t.customTitle }),
      } satisfies TerminalTab);
    } else {
      tabs.push({
        id: t.id,
        kind: "editor",
        title: t.title,
        path: t.path,
        dirty: false,
        preview: false,
      } satisfies EditorTab);
    }
  }

  if (!restored || tabs.length === 0) {
    const tabId = 1;
    const leafId = 2;
    return {
      tabs: [
        {
          id: tabId,
          kind: "terminal",
          title: initial?.title ?? "shell",
          cwd: initial?.cwd,
          paneTree: { kind: "leaf", id: leafId, cwd: initial?.cwd },
          activeLeafId: leafId,
        },
      ],
      activeId: tabId,
      editorGroups: EMPTY_GROUPS,
      nextId: 3,
    };
  }

  const editorIds = new Set(
    tabs.filter((t) => t.kind === "editor").map((t) => t.id),
  );
  const editorGroups = sanitizeEditorGroups(
    restored.editorGroups ?? EMPTY_GROUPS,
    editorIds,
  );

  let maxId = 0;
  for (const t of tabs) {
    maxId = Math.max(maxId, t.id);
    if (t.kind === "terminal")
      maxId = Math.max(maxId, maxPaneId(t.paneTree), t.activeLeafId);
  }
  if (editorGroups.layout)
    maxId = Math.max(maxId, maxPaneId(editorGroups.layout));

  const activeId =
    restored.activeTabId != null &&
    tabs.some((t) => t.id === restored.activeTabId)
      ? restored.activeTabId
      : tabs[0].id;

  return { tabs, activeId, editorGroups, nextId: maxId + 1 };
}
