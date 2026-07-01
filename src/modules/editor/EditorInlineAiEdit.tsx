import { unifiedMergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  Cancel01Icon,
  SparklesIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { generateInlineEdit } from "@/modules/ai/lib/inlineEdit";
import { aiEditCompartment } from "./lib/extensions";
import { languageLabel } from "./lib/languageLabel";

type Props = {
  view: EditorView;
  path: string;
  /** Called after the overlay is dismissed so the host can refocus the editor. */
  onClose: () => void;
};

type Phase =
  | { kind: "input" }
  | { kind: "loading" }
  | { kind: "preview" }
  | { kind: "error"; message: string };

const DIFF_THEME = EditorView.theme({
  ".cm-changedText": { background: "#88ff881a !important" },
  ".cm-deletedChunk": {
    backgroundColor: "color-mix(in srgb, #ef4444 8%, transparent)",
  },
});

const PREVIEW_EXT = (original: string) => [
  EditorState.readOnly.of(true),
  unifiedMergeView({
    original,
    mergeControls: false,
    highlightChanges: true,
    gutter: true,
    syntaxHighlightDeletions: true,
    collapseUnchanged: { margin: 3, minSize: 6 },
  }),
  DIFF_THEME,
];

export function EditorInlineAiEdit({ view, path, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "input" });
  const [pos, setPos] = useState<{ top: number; left: number }>({
    top: 0,
    left: 0,
  });
  const inputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Target range + the pristine document, captured once on open. If nothing is
  // selected, the edit targets the current line.
  const target = useRef<{
    from: number;
    to: number;
    selected: string;
    originalDoc: string;
  } | null>(null);
  // Length of the applied replacement, so Discard can revert exactly.
  const appliedLenRef = useRef(0);

  if (target.current === null) {
    const sel = view.state.selection.main;
    let { from, to } = sel;
    if (from === to) {
      const line = view.state.doc.lineAt(from);
      from = line.from;
      to = line.to;
    }
    target.current = {
      from,
      to,
      selected: view.state.sliceDoc(from, to),
      originalDoc: view.state.doc.toString(),
    };
  }

  const measure = () => {
    const t = target.current;
    if (!t) return;
    const scroll = view.scrollDOM.getBoundingClientRect();
    const coords = view.coordsAtPos(t.from);
    const top = coords
      ? Math.min(coords.bottom + 6, scroll.bottom - 60)
      : scroll.top + 8;
    setPos({
      top: Math.max(scroll.top + 4, top),
      left: scroll.left + scroll.width / 2,
    });
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the diff layout appears
  useLayoutEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [phase.kind]);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      clearTimeout(t);
      abortRef.current?.abort();
    };
  }, []);

  /** Remove the inline diff + read-only lock without touching the text. */
  const clearPreview = () => {
    view.dispatch({ effects: aiEditCompartment.reconfigure([]) });
  };

  const close = () => {
    abortRef.current?.abort();
    onClose();
  };

  const accept = () => {
    clearPreview();
    onClose();
  };

  const discard = () => {
    const t = target.current;
    if (t) {
      clearPreview();
      // Revert the applied region back to the original snippet.
      view.dispatch({
        changes: {
          from: t.from,
          to: t.from + appliedLenRef.current,
          insert: t.selected,
        },
        selection: { anchor: t.from, head: t.from + t.selected.length },
      });
    }
    onClose();
  };

  const generate = () => {
    const q = query.trim();
    const t = target.current;
    if (!q || !t) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPhase({ kind: "loading" });
    generateInlineEdit(
      t.selected,
      q,
      { language: languageLabel(path), path },
      ctrl.signal,
    )
      .then((newText) => {
        if (ctrl.signal.aborted) return;
        // Apply the edit, then overlay the inline diff against the pristine doc.
        view.dispatch({ changes: { from: t.from, to: t.to, insert: newText } });
        appliedLenRef.current = newText.length;
        view.dispatch({
          effects: aiEditCompartment.reconfigure(PREVIEW_EXT(t.originalDoc)),
        });
        setPhase({ kind: "preview" });
      })
      .catch((e) => {
        if (ctrl.signal.aborted) return;
        setPhase({ kind: "error", message: e?.message ?? String(e) });
      });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      if (phase.kind === "preview") discard();
      else close();
      return;
    }
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (phase.kind === "preview") accept();
    else if (phase.kind !== "loading") generate();
  };

  return (
    <div
      data-editor-ai-edit
      className="fixed z-20 w-[min(560px,92%)] -translate-x-1/2"
      style={{ top: pos.top, left: pos.left }}
    >
      <div className="rounded-2xl border border-border bg-popover/95 p-2 shadow-lg backdrop-blur">
        <div className="flex items-center gap-2">
          <HugeiconsIcon
            icon={SparklesIcon}
            size={14}
            className="shrink-0 text-muted-foreground"
          />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            readOnly={phase.kind === "preview"}
            placeholder={
              phase.kind === "preview"
                ? "Review the diff — Enter to accept, Esc to discard"
                : "Edit selection with AI… (Enter to generate, Esc to cancel)"
            }
            className="h-7 rounded-xl bg-transparent px-2 text-xs"
            spellCheck={false}
          />
          {phase.kind === "loading" ? (
            <Spinner className="size-3.5 shrink-0" />
          ) : (
            <button
              type="button"
              onClick={phase.kind === "preview" ? discard : close}
              className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
              aria-label="Close"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
            </button>
          )}
        </div>
        {phase.kind === "preview" && (
          <div className="mt-2 flex items-center justify-end gap-2">
            <Button size="xs" variant="ghost" onClick={discard}>
              <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
              Discard
            </Button>
            <Button size="xs" variant="default" onClick={accept}>
              <HugeiconsIcon icon={Tick02Icon} size={12} strokeWidth={2} />
              Accept ⏎
            </Button>
          </div>
        )}
        {phase.kind === "error" && (
          <div className="mt-2 px-1 text-xs text-destructive">
            {phase.message}
          </div>
        )}
      </div>
    </div>
  );
}
