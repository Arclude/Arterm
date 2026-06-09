import {
  type Extension,
  Prec,
  RangeSet,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  type DecorationSet,
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  gutter,
} from "@codemirror/view";
import { debugController } from "@/modules/dap/session";
import { useDebugStore } from "@/modules/dap/store";

// CodeMirror integration for the debugger: a clickable breakpoint gutter and an
// execution-line highlight. State lives in the zustand debug store; a small
// ViewPlugin bridges store → CodeMirror effects so the editor stays in sync
// whether breakpoints are toggled here or verified by the adapter.

const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();

// --- effects pushing store state into the editor ---
const setBreakpointsEffect =
  StateEffect.define<{ line: number; verified: boolean }[]>();
const setExecLineEffect = StateEffect.define<number | null>();

// --- breakpoint gutter ---
class BreakpointMarker extends GutterMarker {
  constructor(readonly verified: boolean) {
    super();
  }
  eq(other: BreakpointMarker) {
    return other.verified === this.verified;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className =
      "cm-breakpoint-marker" + (this.verified ? "" : " cm-breakpoint-pending");
    el.textContent = "●";
    return el;
  }
}

const breakpointField = StateField.define<RangeSet<GutterMarker>>({
  create() {
    return RangeSet.empty;
  },
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setBreakpointsEffect)) {
        const marks = [];
        for (const bp of e.value) {
          if (bp.line >= 1 && bp.line <= tr.state.doc.lines) {
            const line = tr.state.doc.line(bp.line);
            marks.push(new BreakpointMarker(bp.verified).range(line.from));
          }
        }
        set = RangeSet.of(marks, true);
      }
    }
    return set;
  },
});

function breakpointGutter(path: string): Extension {
  return gutter({
    class: "cm-breakpoint-gutter",
    markers: (view) => view.state.field(breakpointField),
    initialSpacer: () => new BreakpointMarker(true),
    domEventHandlers: {
      mousedown(view, line) {
        const lineNo = view.state.doc.lineAt(line.from).number; // 1-based
        debugController.toggleBreakpoint(path, lineNo);
        return true;
      },
    },
  });
}

// --- execution-line highlight ---
const execLineDeco = Decoration.line({ class: "cm-debug-exec-line" });

const execLineField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setExecLineEffect)) {
        const lineNo = e.value;
        if (lineNo == null || lineNo < 1 || lineNo > tr.state.doc.lines) {
          deco = Decoration.none;
        } else {
          const line = tr.state.doc.line(lineNo);
          deco = Decoration.set([execLineDeco.range(line.from)]);
        }
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// --- store → editor bridge ---
function debugSyncPlugin(path: string): Extension {
  const myPath = norm(path);
  return ViewPlugin.define((view) => {
    const apply = () => {
      const s = useDebugStore.getState();
      const bps = s.breakpoints[path] ?? [];
      const execLine =
        s.stoppedAt && norm(s.stoppedAt.path) === myPath
          ? s.stoppedAt.line
          : null;
      const effects: StateEffect<unknown>[] = [
        setBreakpointsEffect.of(
          bps.map((b) => ({ line: b.line, verified: b.verified })),
        ),
        setExecLineEffect.of(execLine),
      ];
      // Bring the paused line into view when execution stops here.
      if (
        execLine != null &&
        execLine >= 1 &&
        execLine <= view.state.doc.lines
      ) {
        const pos = view.state.doc.line(execLine).from;
        effects.push(EditorView.scrollIntoView(pos, { y: "center" }));
      }
      view.dispatch({ effects });
    };

    // Initial paint — can't dispatch during plugin construction.
    queueMicrotask(apply);

    const unsub = useDebugStore.subscribe((s, prev) => {
      if (
        s.breakpoints[path] !== prev.breakpoints[path] ||
        s.stoppedAt !== prev.stoppedAt
      ) {
        apply();
      }
    });

    return {
      destroy() {
        unsub();
      },
    };
  });
}

const debugTheme = EditorView.theme({
  ".cm-breakpoint-gutter": {
    width: "18px",
    cursor: "pointer",
  },
  ".cm-breakpoint-gutter .cm-gutterElement": {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  ".cm-breakpoint-gutter .cm-gutterElement:hover": {
    backgroundColor: "color-mix(in srgb, #e51400 12%, transparent)",
  },
  ".cm-breakpoint-marker": {
    color: "#e51400",
    fontSize: "12px",
    lineHeight: "1",
  },
  ".cm-breakpoint-marker.cm-breakpoint-pending": {
    color: "color-mix(in srgb, #e51400 45%, transparent)",
  },
  // VS Code-style hover hint: show a faint dot on empty gutter lines so the
  // click target is discoverable. Suppressed where a breakpoint already exists.
  ".cm-breakpoint-gutter .cm-gutterElement:hover:not(:has(.cm-breakpoint-marker))::after":
    {
      content: '"●"',
      color: "color-mix(in srgb, #e51400 40%, transparent)",
      fontSize: "12px",
      lineHeight: "1",
    },
  ".cm-debug-exec-line": {
    backgroundColor: "color-mix(in srgb, #ffd166 22%, transparent)",
  },
});

export function debugExtension(path: string): Extension {
  return [
    breakpointField,
    execLineField,
    // High precedence so this gutter renders to the LEFT of the line numbers,
    // matching the VS Code breakpoint placement.
    Prec.high(breakpointGutter(path)),
    debugSyncPlugin(path),
    debugTheme,
  ];
}
