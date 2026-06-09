import { Fragment, useEffect, useRef } from "react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import type { EditorGroupsState, EditorTab, Tab } from "@/modules/tabs";
import type { PaneNode, SplitDir } from "@/modules/terminal/lib/panes";
import { EditorGroupStrip } from "./EditorGroupStrip";
import { EditorPane, type EditorPaneHandle } from "./EditorPane";
import { getDraggedTab, TAB_MIME } from "./lib/tabDnd";

type Props = {
  /** Editor-group grid state (which editor tabs live in which pane). */
  groups: EditorGroupsState;
  /** All tabs — used to resolve editor tab data (title, path, dirty). */
  tabs: Tab[];
  /** Workspace root for breadcrumbs and the debuggee cwd. */
  workspaceRoot: string | null;
  onDirtyChange: (id: number, dirty: boolean) => void;
  registerHandle: (id: number, handle: EditorPaneHandle | null) => void;
  /** Activate a tab within a group (and focus that group). */
  onActivateTab: (groupId: number, tabId: number) => void;
  /** Close an editor tab (prompts on dirty upstream). */
  onCloseTab: (id: number) => void;
  /** Focus a group (e.g. clicking in its body). */
  onFocusGroup: (groupId: number) => void;
  /** Split the focused group. */
  onSplitGroup: (dir: SplitDir) => void;
  /** Move a dragged tab into a group at an index (drag & drop). */
  onMoveTab: (tabId: number, toGroupId: number, index: number) => void;
};

export function EditorStack({
  groups,
  tabs,
  workspaceRoot,
  onDirtyChange,
  registerHandle,
  onActivateTab,
  onCloseTab,
  onFocusGroup,
  onSplitGroup,
  onMoveTab,
}: Props) {
  // Stable per-tab callbacks. Inline arrows in `ref`/`onDirtyChange` change
  // identity every render, which makes React detach+reattach the ref callback
  // and re-invoke onDirtyChange, triggering setState loops in the parent.
  const registerRef = useRef(registerHandle);
  const dirtyRef = useRef(onDirtyChange);
  const closeRef = useRef(onCloseTab);
  registerRef.current = registerHandle;
  dirtyRef.current = onDirtyChange;
  closeRef.current = onCloseTab;

  const refCallbacks = useRef(
    new Map<number, (h: EditorPaneHandle | null) => void>(),
  );
  const dirtyCallbacks = useRef(new Map<number, (dirty: boolean) => void>());
  const closeCallbacks = useRef(new Map<number, () => void>());

  const getRefCallback = (id: number) => {
    let cb = refCallbacks.current.get(id);
    if (!cb) {
      cb = (h: EditorPaneHandle | null) => registerRef.current(id, h);
      refCallbacks.current.set(id, cb);
    }
    return cb;
  };
  const getDirtyCallback = (id: number) => {
    let cb = dirtyCallbacks.current.get(id);
    if (!cb) {
      cb = (dirty: boolean) => dirtyRef.current(id, dirty);
      dirtyCallbacks.current.set(id, cb);
    }
    return cb;
  };
  const getCloseCallback = (id: number) => {
    let cb = closeCallbacks.current.get(id);
    if (!cb) {
      cb = () => closeRef.current(id);
      closeCallbacks.current.set(id, cb);
    }
    return cb;
  };

  const editorsById = new Map<number, EditorTab>(
    tabs
      .filter((t): t is EditorTab => t.kind === "editor")
      .map((t) => [t.id, t]),
  );

  // Drop callback entries for closed tabs to avoid unbounded growth.
  useEffect(() => {
    const live = new Set(editorsById.keys());
    for (const m of [
      refCallbacks.current,
      dirtyCallbacks.current,
      closeCallbacks.current,
    ]) {
      for (const id of m.keys()) if (!live.has(id)) m.delete(id);
    }
  });

  if (!groups.layout) return null;

  const renderGroup = (gid: number) => {
    const g = groups.groups[gid];
    if (!g) return null;
    const focused = groups.activeGroupId === gid;
    return (
      <div
        className="flex h-full min-h-0 w-full flex-col"
        onMouseDownCapture={() => {
          if (!focused) onFocusGroup(gid);
        }}
      >
        <EditorGroupStrip
          groupId={gid}
          group={g}
          tabsById={editorsById}
          isFocused={focused}
          workspaceRoot={workspaceRoot}
          onActivate={(tabId) => onActivateTab(gid, tabId)}
          onClose={onCloseTab}
          onSplit={(dir) => {
            if (!focused) onFocusGroup(gid);
            onSplitGroup(dir);
          }}
          onMoveTab={onMoveTab}
        />
        <div
          className="relative min-h-0 flex-1"
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(TAB_MIME)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }}
          onDrop={(e) => {
            if (!e.dataTransfer.types.includes(TAB_MIME)) return;
            e.preventDefault();
            const id =
              Number(e.dataTransfer.getData(TAB_MIME)) || getDraggedTab();
            if (id) onMoveTab(id, gid, g.tabIds.length);
          }}
        >
          {g.tabIds.map((id) => {
            const t = editorsById.get(id);
            if (!t) return null;
            const visible = id === g.activeTabId;
            return (
              <div
                key={id}
                className={cn(
                  "absolute inset-0",
                  !visible && "invisible pointer-events-none",
                )}
                aria-hidden={!visible}
              >
                <div className="h-full overflow-hidden bg-background">
                  <EditorPane
                    ref={getRefCallback(id)}
                    path={t.path}
                    workspaceRoot={workspaceRoot}
                    onDirtyChange={getDirtyCallback(id)}
                    onClose={getCloseCallback(id)}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const renderNode = (node: PaneNode) => {
    if (node.kind === "leaf") return renderGroup(node.id);
    return (
      <ResizablePanelGroup
        orientation={node.dir === "row" ? "horizontal" : "vertical"}
        className="h-full w-full"
      >
        {node.children.map((child, i) => (
          <Fragment key={child.id}>
            {i > 0 ? <ResizableHandle /> : null}
            <ResizablePanel minSize="15%">{renderNode(child)}</ResizablePanel>
          </Fragment>
        ))}
      </ResizablePanelGroup>
    );
  };

  return <div className="h-full w-full">{renderNode(groups.layout)}</div>;
}
