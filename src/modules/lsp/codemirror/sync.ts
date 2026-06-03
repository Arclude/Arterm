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
    const text = update.state.doc.toString();
    timer = setTimeout(() => {
      timer = undefined;
      client.didChange(uri, text);
    }, DEBOUNCE_MS);
  });
}
