import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import type { EditorTab, Tab } from "@/modules/tabs";
import { useEffect, useRef } from "react";
import { EditorPane, type EditorPaneHandle } from "./EditorPane";

type Props = {
  tabs: Tab[];
  activeId: number;
  onDirtyChange: (id: number, dirty: boolean) => void;
  registerHandle: (id: number, handle: EditorPaneHandle | null) => void;
  onCloseTab: (id: number) => void;
  /** When set, this file is shown (live-synced) in a second pane beside the main editor. */
  splitPath?: string | null;
  /** Split orientation: "row" = side by side, "col" = stacked. */
  splitDir?: "row" | "col" | null;
  /** Collapse the split back to a single pane. */
  onCloseSplit?: () => void;
};

export function EditorStack({
  tabs,
  activeId,
  onDirtyChange,
  registerHandle,
  onCloseTab,
  splitPath,
  splitDir,
  onCloseSplit,
}: Props) {
  const editors = tabs.filter((t): t is EditorTab => t.kind === "editor");

  // Stable per-tab callbacks. Inline arrows in `ref` and `onDirtyChange`
  // change identity every render, which makes React detach+reattach the ref
  // callback and re-invoke `onDirtyChange`, triggering setState loops in
  // the parent. Memoizing per id keeps each callback's identity stable.
  const registerRef = useRef(registerHandle);
  const dirtyRef = useRef(onDirtyChange);
  const closeRef = useRef(onCloseTab);
  useEffect(() => {
    registerRef.current = registerHandle;
  }, [registerHandle]);
  useEffect(() => {
    dirtyRef.current = onDirtyChange;
  }, [onDirtyChange]);
  useEffect(() => {
    closeRef.current = onCloseTab;
  }, [onCloseTab]);

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

  // Drop callback entries for closed tabs to avoid unbounded growth.
  useEffect(() => {
    const live = new Set(editors.map((t) => t.id));
    for (const id of refCallbacks.current.keys()) {
      if (!live.has(id)) refCallbacks.current.delete(id);
    }
    for (const id of dirtyCallbacks.current.keys()) {
      if (!live.has(id)) dirtyCallbacks.current.delete(id);
    }
    for (const id of closeCallbacks.current.keys()) {
      if (!live.has(id)) closeCallbacks.current.delete(id);
    }
  }, [editors]);

  if (editors.length === 0) return null;

  const renderPane = (t: EditorTab, visible: boolean) => (
    <div
      key={t.id}
      className={cn(
        "absolute inset-0",
        !visible && "invisible pointer-events-none",
      )}
      aria-hidden={!visible}
    >
      <div className="h-full overflow-hidden rounded-md border border-border/60 bg-background">
        <EditorPane
          ref={getRefCallback(t.id)}
          path={t.path}
          onDirtyChange={getDirtyCallback(t.id)}
          onClose={getCloseCallback(t.id)}
        />
      </div>
    </div>
  );

  // The main column keeps every open tab as an overlay (active one visible).
  const mainColumn = (
    <div className="relative h-full w-full">
      {editors.map((t) => renderPane(t, t.id === activeId))}
    </div>
  );

  if (!splitPath || !splitDir) return mainColumn;

  // The split pane is a SECOND view of one file. It shares the document buffer
  // with the main pane via the per-path registry in useDocument, so edits in
  // either pane stay in sync without conflicting saves.
  const splitTitle = splitPath.split(/[\\/]/).pop() ?? splitPath;
  const noop = () => {};

  return (
    <ResizablePanelGroup
      orientation={splitDir === "row" ? "horizontal" : "vertical"}
      className="h-full w-full"
    >
      <ResizablePanel minSize="20%">{mainColumn}</ResizablePanel>
      <ResizableHandle />
      <ResizablePanel minSize="20%">
        <div className="flex h-full w-full flex-col">
          <div className="flex h-7 shrink-0 items-center justify-between gap-2 px-2 text-[11px] text-muted-foreground">
            <span className="truncate" title={splitPath}>
              {splitTitle}
            </span>
            <button
              type="button"
              onClick={onCloseSplit}
              title="Close split"
              className="grid size-5 shrink-0 place-items-center rounded hover:bg-muted hover:text-foreground"
            >
              ✕
            </button>
          </div>
          <div className="relative min-h-0 flex-1">
            <div className="absolute inset-0">
              <div className="h-full overflow-hidden rounded-md border border-border/60 bg-background">
                <EditorPane
                  path={splitPath}
                  onDirtyChange={noop}
                  onClose={onCloseSplit ?? noop}
                />
              </div>
            </div>
          </div>
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
