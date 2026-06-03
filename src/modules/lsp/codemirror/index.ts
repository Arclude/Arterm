import type { Extension } from "@codemirror/state";
import type { LspClient } from "../client";
import { lspCompletion } from "./completion";
import { lspDefinition } from "./definition";
import { lspDiagnostics } from "./diagnostics";
import { lspHover } from "./hover";
import { lspSync } from "./sync";

export type LspGotoTarget = { uri: string; line: number; character: number };

export function lspExtensions(
  client: LspClient,
  uri: string,
  onGoto: (target: LspGotoTarget) => void,
): Extension[] {
  return [
    lspSync(client, uri),
    lspDiagnostics(client, uri),
    lspCompletion(client, uri),
    lspHover(client, uri),
    lspDefinition(client, uri, onGoto),
  ];
}
