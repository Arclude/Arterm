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
        return { dom: renderHover(text) };
      },
    };
  });
}

// Hover contents are markdown: a fenced ```lang signature block plus prose docs.
// Render fenced blocks as monospace code and the rest as plain text, instead of
// dumping the raw markdown (backticks and all).
function renderHover(text: string): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cm-lsp-hover";
  const parts = text.split(/```/);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part.trim()) continue;
    const isCode = i % 2 === 1;
    if (isCode) {
      const pre = document.createElement("pre");
      pre.className = "cm-lsp-hover-code";
      // Drop the leading language identifier line (e.g. "typescript\n").
      pre.textContent = part.replace(/^[a-zA-Z0-9]+\n/, "").replace(/\n+$/, "");
      dom.appendChild(pre);
    } else {
      const div = document.createElement("div");
      div.className = "cm-lsp-hover-doc";
      div.textContent = part.trim();
      dom.appendChild(div);
    }
  }
  return dom;
}
