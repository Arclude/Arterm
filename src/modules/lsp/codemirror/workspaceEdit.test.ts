import type {
  TextDocumentEdit,
  WorkspaceEdit,
} from "vscode-languageserver-protocol";
import { describe, expect, it } from "vitest";
import {
  applyTextEditsToString,
  normalizeWorkspaceEdit,
} from "./workspaceEdit";

// Helper: an LSP TextEdit replacing [startLine,startCh]..[endLine,endCh].
const edit = (
  sl: number,
  sc: number,
  el: number,
  ec: number,
  newText: string,
) => ({
  range: { start: { line: sl, character: sc }, end: { line: el, character: ec } },
  newText,
});

describe("applyTextEditsToString", () => {
  it("applies a single in-line replacement", () => {
    const src = "const foo = 1;\n";
    // replace "foo" (chars 6..9 on line 0) with "bar"
    expect(applyTextEditsToString(src, [edit(0, 6, 0, 9, "bar")])).toBe(
      "const bar = 1;\n",
    );
  });

  it("applies multiple non-adjacent edits without offset drift", () => {
    const src = "foo + foo\n";
    const edits = [edit(0, 0, 0, 3, "bar"), edit(0, 6, 0, 9, "bar")];
    // Order in the array shouldn't matter; both occurrences become "bar".
    expect(applyTextEditsToString(src, edits)).toBe("bar + bar\n");
  });

  it("preserves CRLF line endings outside the edited span", () => {
    const src = "a\r\nfoo\r\nb\r\n";
    // replace "foo" on line 1
    expect(applyTextEditsToString(src, [edit(1, 0, 1, 3, "bar")])).toBe(
      "a\r\nbar\r\nb\r\n",
    );
  });

  it("supports multi-line insertions", () => {
    const src = "x\n";
    expect(applyTextEditsToString(src, [edit(0, 0, 0, 1, "y\nz")])).toBe(
      "y\nz\n",
    );
  });
});

describe("normalizeWorkspaceEdit", () => {
  it("flattens the `changes` map", () => {
    const we: WorkspaceEdit = {
      changes: {
        "file:///a.ts": [edit(0, 0, 0, 1, "A")],
        "file:///b.ts": [edit(1, 0, 1, 1, "B")],
      },
    };
    const out = normalizeWorkspaceEdit(we);
    expect(out).toHaveLength(2);
    expect(out.map((f) => f.uri).sort()).toEqual([
      "file:///a.ts",
      "file:///b.ts",
    ]);
  });

  it("flattens `documentChanges` TextDocumentEdits", () => {
    const dce: TextDocumentEdit = {
      textDocument: { uri: "file:///a.ts", version: 1 },
      edits: [edit(0, 0, 0, 1, "A")],
    };
    const we: WorkspaceEdit = { documentChanges: [dce] };
    const out = normalizeWorkspaceEdit(we);
    expect(out).toEqual([
      { uri: "file:///a.ts", edits: [edit(0, 0, 0, 1, "A")] },
    ]);
  });

  it("drops files with no edits", () => {
    const we: WorkspaceEdit = { changes: { "file:///a.ts": [] } };
    expect(normalizeWorkspaceEdit(we)).toEqual([]);
  });
});
