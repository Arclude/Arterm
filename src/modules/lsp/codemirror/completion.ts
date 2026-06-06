import type {
  Completion,
  CompletionContext,
  CompletionResult,
} from "@codemirror/autocomplete";
import { autocompletion } from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import type { CompletionItem } from "vscode-languageserver-protocol";
import { LspClient } from "@/modules/lsp/client";
import { offsetToPosition } from "@/modules/lsp/codemirror/position";

// Maps LSP CompletionItemKind (1–25) to CodeMirror's known completion icon
// types so each suggestion gets a meaningful, color-coded glyph.
function kindToType(kind: number | undefined): string {
  switch (kind) {
    case 2: // Method
      return "method";
    case 3: // Function
    case 4: // Constructor
      return "function";
    case 5: // Field
    case 10: // Property
      return "property";
    case 6: // Variable
    case 12: // Value
      return "variable";
    case 7: // Class
    case 22: // Struct
      return "class";
    case 8: // Interface
      return "interface";
    case 9: // Module
      return "namespace";
    case 13: // Enum
    case 20: // EnumMember
      return "enum";
    case 14: // Keyword
    case 24: // Operator
      return "keyword";
    case 21: // Constant
    case 11: // Unit
      return "constant";
    case 25: // TypeParameter
      return "type";
    default:
      return "text";
  }
}

function documentationToString(
  doc: CompletionItem["documentation"],
): string | undefined {
  if (doc == null) return undefined;
  if (typeof doc === "string") return doc;
  return doc.value;
}

export function lspCompletion(client: LspClient, uri: string): Extension {
  async function source(
    context: CompletionContext,
  ): Promise<CompletionResult | null> {
    if (client.capabilities?.completionProvider == null) return null;

    const match = context.matchBefore(/[\w$]+/);
    if (match == null && !context.explicit) return null;

    const position = offsetToPosition(context.state.doc, context.pos);
    const result = await client.request<
      CompletionItem[] | { items: CompletionItem[] } | null
    >("textDocument/completion", {
      textDocument: { uri },
      position,
    });

    const items = Array.isArray(result) ? result : (result?.items ?? []);

    const options: Completion[] = items.map((item) => ({
      label: item.label,
      type: kindToType(item.kind),
      detail: item.detail,
      apply: item.insertText ?? item.label,
      info: documentationToString(item.documentation),
    }));

    return {
      from: match?.from ?? context.pos,
      options,
      validFor: /[\w$]*/,
    };
  }

  return autocompletion({ override: [source] });
}
