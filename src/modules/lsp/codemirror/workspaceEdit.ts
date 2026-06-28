import { Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { TextEdit, WorkspaceEdit } from "vscode-languageserver-protocol";
import { positionToOffset } from "./position";

// A single file's worth of edits extracted from a WorkspaceEdit.
export type FileEdits = { uri: string; edits: TextEdit[] };

// The CustomEvent both rename and code-action dispatch; the app applies it
// across open tabs and on-disk files in one place.
export const WORKSPACE_EDIT_EVENT = "arterm:lsp-workspace-edit";

export type WorkspaceEditDetail = { edit: WorkspaceEdit };

// Flattens either shape of a WorkspaceEdit (`changes` map or `documentChanges`)
// into a per-file list. File create/rename/delete resource ops are ignored —
// rename/quick-fix on the servers we target emit plain text edits.
export function normalizeWorkspaceEdit(edit: WorkspaceEdit): FileEdits[] {
  const out: FileEdits[] = [];
  if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      if (edits.length) out.push({ uri, edits });
    }
  }
  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      // Only TextDocumentEdit has a `textDocument` + `edits`; skip resource ops.
      if ("textDocument" in change && Array.isArray(change.edits)) {
        const edits = change.edits as TextEdit[];
        if (edits.length) out.push({ uri: change.textDocument.uri, edits });
      } else {
        console.warn("[lsp] ignoring unsupported workspace edit op", change);
      }
    }
  }
  return out;
}

// Converts LSP TextEdits (line/character ranges) into a CodeMirror change set
// against `doc`. Returned changes are all relative to the original document.
function toChanges(doc: Text, edits: TextEdit[]) {
  return edits.map((e) => ({
    from: positionToOffset(doc, e.range.start),
    to: positionToOffset(doc, e.range.end),
    insert: e.newText,
  }));
}

// Applies edits to a live editor (preserving undo history and dirty state).
export function applyTextEditsToView(view: EditorView, edits: TextEdit[]): void {
  if (!edits.length) return;
  view.dispatch({
    changes: toChanges(view.state.doc, edits),
    userEvent: "rename",
  });
}

// Applies edits to a plain string (for files not open in any editor). Edits are
// applied high-offset-first so earlier offsets stay valid as the text shifts.
export function applyTextEditsToString(
  content: string,
  edits: TextEdit[],
): string {
  const doc = Text.of(content.split("\n"));
  const changes = toChanges(doc, edits).sort((a, b) => b.from - a.from);
  let result = doc;
  for (const c of changes) {
    result = result.replace(c.from, c.to, Text.of(c.insert.split("\n")));
  }
  return result.toString();
}
