import type { Text } from "@codemirror/state";
import type { Position } from "vscode-languageserver-protocol";

// LSP positions are 0-based line + UTF-16 code-unit character. CodeMirror
// offsets are also UTF-16 code units, so character maps directly to the
// in-line column without surrogate-pair adjustment.

export function offsetToPosition(doc: Text, offset: number): Position {
  const clamped = Math.max(0, Math.min(offset, doc.length));
  const line = doc.lineAt(clamped);
  return { line: line.number - 1, character: clamped - line.from };
}

export function positionToOffset(doc: Text, pos: Position): number {
  if (pos.line < 0) return 0;
  if (pos.line >= doc.lines) return doc.length;
  const line = doc.line(pos.line + 1);
  return Math.min(line.from + Math.max(0, pos.character), line.to);
}
