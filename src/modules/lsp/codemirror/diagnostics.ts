import { type Diagnostic, setDiagnostics } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import type {
  Diagnostic as LspDiagnostic,
  PublishDiagnosticsParams,
} from "vscode-languageserver-protocol";
import type { LspClient } from "../client";
import { sameUri } from "../uri";
import { positionToOffset } from "./position";

function severity(s: LspDiagnostic["severity"]): Diagnostic["severity"] {
  switch (s) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 3:
      return "info";
    default:
      return "info";
  }
}

function toCm(view: EditorView, d: LspDiagnostic): Diagnostic {
  const doc = view.state.doc;
  const from = positionToOffset(doc, d.range.start);
  const to = positionToOffset(doc, d.range.end);
  return {
    from,
    to: Math.max(from, to),
    severity: severity(d.severity),
    message: d.source ? `${d.message} (${d.source})` : d.message,
  };
}

// Latest raw LSP diagnostics per document URI. Kept alongside the CodeMirror
// conversion so code actions can send the server its own diagnostic objects
// (preserving fields like `code`/`data` that some quick-fixes rely on).
const lspDiagnosticsByUri = new Map<string, LspDiagnostic[]>();

export function getLspDiagnostics(uri: string): LspDiagnostic[] {
  return lspDiagnosticsByUri.get(uri) ?? [];
}

export function lspDiagnostics(client: LspClient, uri: string): Extension {
  return ViewPlugin.define((view) => {
    const unsub = client.onNotification(
      "textDocument/publishDiagnostics",
      (raw) => {
        const params = raw as PublishDiagnosticsParams;
        if (!sameUri(params.uri, uri)) return;
        lspDiagnosticsByUri.set(uri, params.diagnostics);
        const diags = params.diagnostics
          .map((d) => toCm(view, d))
          .sort((a, b) => a.from - b.from);
        view.dispatch(setDiagnostics(view.state, diags));
      },
    );
    return {
      destroy() {
        unsub();
      },
    };
  });
}
