import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { LspClient } from "../client";

const DEBOUNCE_MS = 250;

// Streams document edits to the server as debounced full-document didChange
// notifications. didOpen/didClose are driven by the editor mount lifecycle.
export function lspSync(client: LspClient, uri: string): Extension {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    if (timer !== undefined) clearTimeout(timer);
    // Capture the doc (cheap, structurally shared) and defer the actual
    // toString() allocation until the debounce fires, so fast typing doesn't
    // allocate a full-document string on every keystroke.
    const doc = update.state.doc;
    timer = setTimeout(() => {
      timer = undefined;
      client.didChange(uri, doc.toString());
    }, DEBOUNCE_MS);
  });
}
