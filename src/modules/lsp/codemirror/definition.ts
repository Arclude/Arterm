import type { Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import type { Location, LocationLink } from "vscode-languageserver-protocol";
import { LspClient } from "@/modules/lsp/client";
import { offsetToPosition } from "@/modules/lsp/codemirror/position";

type DefinitionResult = Location | Location[] | LocationLink[] | null;

function isLocationLink(value: Location | LocationLink): value is LocationLink {
  return "targetUri" in value;
}

export function lspDefinition(
  client: LspClient,
  uri: string,
  onGoto: (target: { uri: string; line: number; character: number }) => void,
): Extension {
  function triggerGoto(view: EditorView, atPos?: number): void {
    const pos = atPos ?? view.state.selection.main.head;
    if (!client.capabilities?.definitionProvider) return;

    const position = offsetToPosition(view.state.doc, pos);

    void (async () => {
      const result = await client.request<DefinitionResult>(
        "textDocument/definition",
        { textDocument: { uri }, position },
      );

      if (result == null) return;
      const first = Array.isArray(result) ? result[0] : result;
      if (first == null) return;

      if (isLocationLink(first)) {
        const range = first.targetSelectionRange ?? first.targetRange;
        onGoto({
          uri: first.targetUri,
          line: range.start.line,
          character: range.start.character,
        });
      } else {
        onGoto({
          uri: first.uri,
          line: first.range.start.line,
          character: first.range.start.character,
        });
      }
    })().catch(() => {});
  }

  return [
    keymap.of([
      {
        key: "F12",
        run: (view) => {
          triggerGoto(view);
          return true;
        },
      },
    ]),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (!(event.ctrlKey || event.metaKey)) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos == null) return false;
        triggerGoto(view, pos);
        return false;
      },
    }),
  ];
}
