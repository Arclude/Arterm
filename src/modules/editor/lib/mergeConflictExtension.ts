// VS Code-style inline merge-conflict resolver for CodeMirror. When a document
// contains Git conflict markers, each region is tinted (ours = green, theirs =
// blue, base = grey) and an action bar is rendered above it with one-click
// "Accept Current / Incoming / Both" buttons. Resolving rewrites the region in a
// single transaction (undoable) and strips the markers.
import { type Extension, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import {
  type ConflictRegion,
  parseConflicts,
  type ResolutionKind,
  resolutionText,
} from "./mergeConflict";

function applyResolution(
  view: EditorView,
  headerFrom: number,
  kind: ResolutionKind,
): void {
  // Re-parse at click time so offsets are always fresh against the live doc.
  const region = parseConflicts(view.state.doc).find((r) => r.from === headerFrom);
  if (!region) return;

  const insert = resolutionText(view.state.doc, region, kind);
  let to = region.to;
  if (insert === "") {
    // Removing the whole region: also swallow the trailing line break so we
    // don't leave a stray blank line behind.
    const footer = view.state.doc.line(region.footerLine);
    if (footer.number < view.state.doc.lines) {
      to = view.state.doc.line(footer.number + 1).from;
    }
  }
  view.dispatch({
    changes: { from: region.from, to, insert },
    userEvent: "mergeConflict.resolve",
    scrollIntoView: true,
  });
}

class ActionBarWidget extends WidgetType {
  constructor(
    readonly headerFrom: number,
    readonly hasBase: boolean,
    readonly currentLabel: string,
    readonly incomingLabel: string,
  ) {
    super();
  }

  eq(other: ActionBarWidget): boolean {
    return (
      other.headerFrom === this.headerFrom &&
      other.hasBase === this.hasBase &&
      other.currentLabel === this.currentLabel &&
      other.incomingLabel === this.incomingLabel
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "cm-merge-actionbar";

    const make = (label: string, title: string, kind: ResolutionKind, cls: string) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `cm-merge-btn ${cls}`;
      btn.textContent = label;
      btn.title = title;
      // Keep the editor selection from collapsing onto the widget on press.
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        applyResolution(view, this.headerFrom, kind);
      });
      return btn;
    };

    bar.appendChild(
      make(
        "Accept Current Change",
        this.currentLabel ? `Keep ${this.currentLabel}` : "Keep current change",
        "current",
        "cm-merge-btn-current",
      ),
    );
    bar.appendChild(
      make(
        "Accept Incoming Change",
        this.incomingLabel ? `Keep ${this.incomingLabel}` : "Keep incoming change",
        "incoming",
        "cm-merge-btn-incoming",
      ),
    );
    bar.appendChild(
      make("Accept Both Changes", "Keep both changes", "both", "cm-merge-btn-both"),
    );
    if (this.hasBase) {
      bar.appendChild(
        make("Accept Base", "Keep the common ancestor", "base", "cm-merge-btn-base"),
      );
    }
    return bar;
  }
}

function classifyLine(region: ConflictRegion, line: number): string | null {
  if (line === region.headerLine) return "cm-merge-marker cm-merge-marker-current";
  if (line === region.footerLine) return "cm-merge-marker cm-merge-marker-incoming";
  if (line === region.sepLine) return "cm-merge-marker cm-merge-marker-sep";
  if (region.baseMarkerLine !== -1 && line === region.baseMarkerLine) {
    return "cm-merge-marker cm-merge-marker-base";
  }
  const currentEnd = region.baseMarkerLine !== -1 ? region.baseMarkerLine : region.sepLine;
  if (line < currentEnd) return "cm-merge-line-current";
  if (region.baseMarkerLine !== -1 && line < region.sepLine) return "cm-merge-line-base";
  return "cm-merge-line-incoming";
}

function buildDecorations(doc: EditorView["state"]["doc"]): DecorationSet {
  const regions = parseConflicts(doc);
  if (regions.length === 0) return Decoration.none;

  const marks = [];
  for (const region of regions) {
    marks.push(
      Decoration.widget({
        widget: new ActionBarWidget(
          region.from,
          region.base !== null,
          region.current.label,
          region.incoming.label,
        ),
        block: true,
        side: -1,
      }).range(region.from),
    );
    for (let line = region.headerLine; line <= region.footerLine; line++) {
      const cls = classifyLine(region, line);
      if (cls) marks.push(Decoration.line({ class: cls }).range(doc.line(line).from));
    }
  }
  return Decoration.set(marks, true);
}

const conflictField = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state.doc),
  update: (deco, tr) => (tr.docChanged ? buildDecorations(tr.state.doc) : deco),
  provide: (f) => EditorView.decorations.from(f),
});

const conflictTheme = EditorView.theme({
  ".cm-merge-line-current": { backgroundColor: "rgba(46, 160, 67, 0.16)" },
  ".cm-merge-line-incoming": { backgroundColor: "rgba(56, 139, 253, 0.16)" },
  ".cm-merge-line-base": { backgroundColor: "rgba(130, 130, 130, 0.14)" },
  ".cm-merge-marker": {
    fontWeight: "600",
    color: "var(--muted-foreground, #888)",
  },
  ".cm-merge-marker-current": { backgroundColor: "rgba(46, 160, 67, 0.28)" },
  ".cm-merge-marker-incoming": { backgroundColor: "rgba(56, 139, 253, 0.28)" },
  ".cm-merge-marker-base": { backgroundColor: "rgba(130, 130, 130, 0.24)" },
  ".cm-merge-marker-sep": { backgroundColor: "rgba(130, 130, 130, 0.2)" },
  ".cm-merge-actionbar": {
    display: "flex",
    flexWrap: "wrap",
    gap: "10px",
    alignItems: "center",
    padding: "1px 8px 2px",
    font: "500 11px/1.6 var(--font-sans, system-ui, sans-serif)",
    userSelect: "none",
  },
  ".cm-merge-btn": {
    background: "none",
    border: "none",
    padding: "0",
    cursor: "pointer",
    fontWeight: "600",
    fontSize: "11px",
    color: "rgba(56, 139, 253, 0.95)",
  },
  ".cm-merge-btn:hover": { textDecoration: "underline" },
  ".cm-merge-btn-current": { color: "rgba(46, 160, 67, 0.95)" },
  ".cm-merge-btn-incoming": { color: "rgba(56, 139, 253, 0.95)" },
  ".cm-merge-btn-both": { color: "var(--foreground, #ccc)" },
  ".cm-merge-btn-base": { color: "rgba(150, 150, 150, 0.95)" },
});

/** Inline merge-conflict decorations + accept buttons. Inert without markers. */
export function mergeConflictExtension(): Extension {
  return [conflictField, conflictTheme];
}
