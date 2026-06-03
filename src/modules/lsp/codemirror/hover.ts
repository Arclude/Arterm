import type { Extension } from "@codemirror/state";
import type { Tooltip } from "@codemirror/view";
import { hoverTooltip } from "@codemirror/view";
import type { Hover, MarkedString } from "vscode-languageserver-protocol";
import { LspClient } from "@/modules/lsp/client";
import { offsetToPosition } from "@/modules/lsp/codemirror/position";

function markedStringToText(value: string | MarkedString): string {
  if (typeof value === "string") return value;
  return value.value;
}

function flattenContents(contents: Hover["contents"]): string {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) {
    return contents.map(markedStringToText).filter(Boolean).join("\n\n");
  }
  if ("kind" in contents) return contents.value;
  return contents.value;
}

export function lspHover(client: LspClient, uri: string): Extension {
  return hoverTooltip(async (view, pos, _side): Promise<Tooltip | null> => {
    if (!client.capabilities?.hoverProvider) return null;

    const position = offsetToPosition(view.state.doc, pos);
    const result = await client.request<Hover | null>("textDocument/hover", {
      textDocument: { uri },
      position,
    });

    if (result == null) return null;

    const text = flattenContents(result.contents).trim();
    if (text.length === 0) return null;

    return {
      pos,
      above: false,
      create() {
        const dom = document.createElement("div");
        dom.className = "cm-lsp-hover";
        dom.textContent = text;
        return { dom };
      },
    };
  });
}
