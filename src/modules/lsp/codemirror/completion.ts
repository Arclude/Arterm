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

function kindToType(kind: number | undefined): string {
  switch (kind) {
    case 2:
      return "method";
    case 3:
      return "function";
    case 5:
      return "property";
    case 6:
      return "variable";
    case 7:
      return "class";
    case 8:
      return "interface";
    case 9:
      return "namespace";
    case 14:
      return "keyword";
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
