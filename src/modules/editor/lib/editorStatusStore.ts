import { create } from "zustand";

/**
 * Live cursor / document info for the focused editor, published by the active
 * EditorPane and read by the app status bar (VS Code-style Ln/Col, selection,
 * language and indentation segments). Only one editor "owns" the status at a
 * time — whichever pane was last interacted with — mirroring VS Code's active
 * editor. `path` lets the status bar gate display on the currently active file.
 */
export type EditorStatus = {
  /** Absolute path of the editor that published this status. */
  path: string;
  /** 1-based cursor line. */
  line: number;
  /** 1-based cursor column. */
  col: number;
  /** Number of selection ranges (>1 means multiple cursors). */
  selections: number;
  /** Total selected characters across all ranges. */
  selectedChars: number;
  /** Human label for the language, e.g. "TypeScript". */
  language: string;
  /** Indentation label, e.g. "Spaces: 2". */
  indent: string;
};

type EditorStatusState = {
  status: EditorStatus | null;
  /** Publish status for `path`, becoming the active owner. */
  set: (status: EditorStatus) => void;
  /** Clear only if `path` is the current owner (call on blur/unmount). */
  clear: (path: string) => void;
};

export const useEditorStatusStore = create<EditorStatusState>((set, get) => ({
  status: null,
  set: (status) => set({ status }),
  clear: (path) => {
    if (get().status?.path === path) set({ status: null });
  },
}));
