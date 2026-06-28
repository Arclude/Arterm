import type { Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import type { WorkspaceEdit } from "vscode-languageserver-protocol";
import type { LspClient } from "../client";
import { offsetToPosition } from "./position";
import {
  WORKSPACE_EDIT_EVENT,
  type WorkspaceEditDetail,
} from "./workspaceEdit";

// Floating single-line input anchored at the symbol, prefilled with its current
// name. Enter commits, Escape/blur cancels. Returns focus to the editor either
// way. Styled inline so it doesn't depend on extra CSS being loaded.
function showRenameInput(
  view: EditorView,
  from: number,
  initial: string,
  onSubmit: (newName: string) => void,
): void {
  const coords = view.coordsAtPos(from);
  if (!coords) return;

  const input = document.createElement("input");
  input.value = initial;
  input.spellcheck = false;
  Object.assign(input.style, {
    position: "fixed",
    left: `${coords.left}px`,
    top: `${coords.top}px`,
    zIndex: "1000",
    minWidth: "8rem",
    padding: "1px 4px",
    font: "inherit",
    fontFamily: "var(--font-mono, monospace)",
    color: "var(--foreground)",
    background: "var(--popover, var(--background))",
    border: "1px solid var(--ring, var(--border))",
    borderRadius: "4px",
    outline: "none",
    boxShadow: "0 2px 8px rgba(0,0,0,0.35)",
  } satisfies Partial<CSSStyleDeclaration>);

  document.body.appendChild(input);
  input.focus();
  input.select();

  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    input.remove();
  };

  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      const value = input.value.trim();
      cleanup();
      view.focus();
      if (value && value !== initial) onSubmit(value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      cleanup();
      view.focus();
    }
  });
  input.addEventListener("blur", cleanup);
}

async function requestRename(
  client: LspClient,
  uri: string,
  view: EditorView,
  pos: number,
  newName: string,
): Promise<void> {
  const position = offsetToPosition(view.state.doc, pos);
  const edit = await client.request<WorkspaceEdit | null>(
    "textDocument/rename",
    { textDocument: { uri }, position, newName },
  );
  if (!edit) return;
  const detail: WorkspaceEditDetail = { edit };
  window.dispatchEvent(new CustomEvent(WORKSPACE_EDIT_EVENT, { detail }));
}

// F2 → rename the symbol under the cursor across the workspace. The resulting
// WorkspaceEdit is broadcast as a CustomEvent; the app applies it to open tabs
// and on-disk files (see App's workspace-edit listener).
export function lspRename(client: LspClient, uri: string): Extension {
  return keymap.of([
    {
      key: "F2",
      preventDefault: true,
      run: (view) => {
        if (!client.capabilities?.renameProvider) return false;
        const pos = view.state.selection.main.head;
        const word = view.state.wordAt(pos);
        if (!word) return false;
        const initial = view.state.doc.sliceString(word.from, word.to);
        showRenameInput(view, word.from, initial, (newName) => {
          void requestRename(client, uri, view, pos, newName).catch((e) =>
            console.warn("[lsp] rename failed:", e),
          );
        });
        return true;
      },
    },
  ]);
}
