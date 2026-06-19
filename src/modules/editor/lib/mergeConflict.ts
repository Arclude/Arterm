// Parses Git merge-conflict markers out of a document so the editor can render
// VS Code-style "Accept Current / Incoming / Both" affordances over each region.
//
// Supported markers (each must start at column 0):
//   <<<<<<< <label>   current change (ours / HEAD)
//   ||||||| <label>   common ancestor (only present with merge.conflictStyle=diff3)
//   =======           separator
//   >>>>>>> <label>   incoming change (theirs)
import type { Text } from "@codemirror/state";

const CURRENT_RE = /^<{7}(?:\s|$)/;
const BASE_RE = /^\|{7}(?:\s|$)/;
const SEP_RE = /^={7}\s*$/;
const INCOMING_RE = /^>{7}(?:\s|$)/;

export type ConflictBlock = {
  /** Absolute doc offset of the first content character. */
  from: number;
  /** Absolute doc offset just past the last content character. */
  to: number;
  /** Branch label that follows the marker (e.g. "HEAD", "feature/x"). */
  label: string;
};

export type ConflictRegion = {
  /** 1-based line of the `<<<<<<<` marker. */
  headerLine: number;
  /** 1-based line of the `|||||||` base marker, or -1 when absent. */
  baseMarkerLine: number;
  /** 1-based line of the `=======` separator. */
  sepLine: number;
  /** 1-based line of the `>>>>>>>` marker. */
  footerLine: number;
  /** Doc offset at the start of the `<<<<<<<` line. */
  from: number;
  /** Doc offset at the end of the `>>>>>>>` line (before its trailing break). */
  to: number;
  current: ConflictBlock;
  base: ConflictBlock | null;
  incoming: ConflictBlock;
};

/** Cheap pre-check so callers can skip the line scan on ordinary files. */
export function hasConflictMarkers(text: string): boolean {
  return /(^|\n)<{7}(?:\s|$)/.test(text);
}

/**
 * Content lines strictly between two marker lines, as a doc offset range.
 * Returns an empty range (anchored at the end marker) when the block is empty.
 */
function blockRange(doc: Text, startMarkerLine: number, endMarkerLine: number) {
  if (endMarkerLine - startMarkerLine <= 1) {
    const at = doc.line(endMarkerLine).from;
    return { from: at, to: at };
  }
  return {
    from: doc.line(startMarkerLine + 1).from,
    to: doc.line(endMarkerLine - 1).to,
  };
}

export function parseConflicts(doc: Text): ConflictRegion[] {
  const regions: ConflictRegion[] = [];
  const total = doc.lines;

  let i = 1;
  while (i <= total) {
    if (!CURRENT_RE.test(doc.line(i).text)) {
      i++;
      continue;
    }

    const headerLine = i;
    const currentLabel = doc.line(i).text.slice(7).trim();
    let baseMarkerLine = -1;
    let baseLabel = "";
    let sepLine = -1;
    let footerLine = -1;

    // Walk forward looking for: [base] -> separator -> footer. Bail (and let the
    // outer loop re-anchor) if we hit another header first or run off the end.
    let j = i + 1;
    let aborted = false;
    while (j <= total) {
      const text = doc.line(j).text;
      if (CURRENT_RE.test(text)) {
        // Nested/restarted conflict — abandon this one, restart from j.
        aborted = true;
        break;
      }
      if (sepLine === -1 && baseMarkerLine === -1 && BASE_RE.test(text)) {
        baseMarkerLine = j;
        baseLabel = text.slice(7).trim();
      } else if (sepLine === -1 && SEP_RE.test(text)) {
        sepLine = j;
      } else if (sepLine !== -1 && INCOMING_RE.test(text)) {
        footerLine = j;
        break;
      }
      j++;
    }

    if (aborted) {
      i = j;
      continue;
    }
    if (sepLine === -1 || footerLine === -1) {
      // Malformed / incomplete — skip past the header and move on.
      i = headerLine + 1;
      continue;
    }

    const currentEndMarker = baseMarkerLine === -1 ? sepLine : baseMarkerLine;
    const current = {
      ...blockRange(doc, headerLine, currentEndMarker),
      label: currentLabel,
    };
    const base =
      baseMarkerLine === -1
        ? null
        : { ...blockRange(doc, baseMarkerLine, sepLine), label: baseLabel };
    const incoming = {
      ...blockRange(doc, sepLine, footerLine),
      label: doc.line(footerLine).text.slice(7).trim(),
    };

    regions.push({
      headerLine,
      baseMarkerLine,
      sepLine,
      footerLine,
      from: doc.line(headerLine).from,
      to: doc.line(footerLine).to,
      current,
      base,
      incoming,
    });

    i = footerLine + 1;
  }

  return regions;
}

export type ResolutionKind = "current" | "incoming" | "both" | "base";

/** The replacement text for resolving a region a given way (markers stripped). */
export function resolutionText(
  doc: Text,
  region: ConflictRegion,
  kind: ResolutionKind,
): string {
  const slice = (b: ConflictBlock) => doc.sliceString(b.from, b.to);
  switch (kind) {
    case "current":
      return slice(region.current);
    case "incoming":
      return slice(region.incoming);
    case "base":
      return region.base ? slice(region.base) : "";
    case "both": {
      const a = slice(region.current);
      const b = slice(region.incoming);
      if (!a) return b;
      if (!b) return a;
      return `${a}\n${b}`;
    }
  }
}
