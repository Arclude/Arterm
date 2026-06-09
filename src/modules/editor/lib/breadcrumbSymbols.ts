import type {
  DocumentSymbol,
  Position,
  Range,
  SymbolInformation,
} from "vscode-languageserver-protocol";

export type AnySymbol = DocumentSymbol | SymbolInformation;

function inRange(pos: Position, range: Range): boolean {
  const afterStart =
    pos.line > range.start.line ||
    (pos.line === range.start.line && pos.character >= range.start.character);
  const beforeEnd =
    pos.line < range.end.line ||
    (pos.line === range.end.line && pos.character <= range.end.character);
  return afterStart && beforeEnd;
}

function rangeSize(r: Range): number {
  return (
    (r.end.line - r.start.line) * 100000 + (r.end.character - r.start.character)
  );
}

// Resolve the enclosing symbol-name chain at `pos`, e.g. ["Home"] or
// ["MyClass", "method"]. Handles both hierarchical DocumentSymbol[] (with
// `range` + `children`) and flat SymbolInformation[] (with `location.range`).
export function resolveSymbolPath(
  symbols: AnySymbol[],
  pos: Position,
): string[] {
  if (!symbols || symbols.length === 0) return [];

  // Hierarchical DocumentSymbol path: descend into the innermost child.
  if ("range" in symbols[0]) {
    const path: string[] = [];
    let level = symbols as DocumentSymbol[];
    for (;;) {
      const match = level.find((s) => s.range && inRange(pos, s.range));
      if (!match) break;
      path.push(match.name);
      if (match.children && match.children.length) {
        level = match.children;
        continue;
      }
      break;
    }
    return path;
  }

  // Flat SymbolInformation: pick the smallest range that contains the cursor.
  const flat = (symbols as SymbolInformation[]).filter(
    (s) => s.location?.range && inRange(pos, s.location.range),
  );
  if (flat.length === 0) return [];
  flat.sort(
    (a, b) => rangeSize(a.location.range) - rangeSize(b.location.range),
  );
  return [flat[0].name];
}
