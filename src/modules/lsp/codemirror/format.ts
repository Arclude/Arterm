import { EditorView } from "@codemirror/view";
import type { TextEdit } from "vscode-languageserver-protocol";
import type { LspClient } from "../client";
import { positionToOffset } from "./position";

// Requests whole-document formatting from the language server and applies the
// returned edits to the view in a single transaction. Returns true if edits
// were applied; false if the server has no formatting provider, returned
// nothing, or the document changed while the request was in flight (so the
// caller can fall back to saving the unformatted buffer).
export async function formatDocument(
  view: EditorView,
  client: LspClient,
  uri: string,
): Promise<boolean> {
  if (!client.capabilities?.documentFormattingProvider) return false;

  // Snapshot the document so we can detect concurrent edits and avoid applying
  // edits whose offsets have gone stale.
  const before = view.state.doc;

  let edits: TextEdit[] | null;
  try {
    edits = await client.request<TextEdit[] | null>(
      "textDocument/formatting",
      {
        textDocument: { uri },
        options: { tabSize: 2, insertSpaces: true },
      },
    );
  } catch (e) {
    console.warn("[lsp] formatting failed:", e);
    return false;
  }

  if (!edits || edits.length === 0) return false;
  // The user typed while the server was formatting — the edits no longer line
  // up with the buffer, so discard them rather than corrupt the document.
  if (!view.state.doc.eq(before)) return false;

  const doc = view.state.doc;
  const changes = edits.map((e) => ({
    from: positionToOffset(doc, e.range.start),
    to: positionToOffset(doc, e.range.end),
    insert: e.newText,
  }));

  view.dispatch({
    changes,
    scrollIntoView: true,
    // Server-driven reformat, not a user edit; CodeMirror maps the existing
    // selection through the changes automatically.
    userEvent: "format",
  });
  return true;
}
