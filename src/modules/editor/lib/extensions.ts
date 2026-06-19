import { indentUnit } from "@codemirror/language";
import { lintGutter } from "@codemirror/lint";
import { search } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { detectMonoFontFamily } from "@/lib/fonts";

// Compartments allow runtime reconfiguration without rebuilding state.
export const languageCompartment = new Compartment();
export const readOnlyCompartment = new Compartment();
export const wrapCompartment = new Compartment();
export const vimCompartment = new Compartment();
export const lspCompartment = new Compartment();
export const minimapCompartment = new Compartment();
export const debugCompartment = new Compartment();
export const mergeConflictCompartment = new Compartment();

// Only what basicSetup doesn't already cover, to avoid duplicate extensions.
// basicSetup gives us line numbers, fold gutter, history, indentOnInput,
// bracketMatching, closeBrackets, autocompletion, highlightActiveLine,
// highlightSelectionMatches and the search keymap.
export function buildSharedExtensions(): Extension[] {
  return [
    indentUnit.of("  "),
    EditorState.tabSize.of(2),
    search({ top: true }),
    lintGutter(),
    EditorView.theme({
      "&, &.cm-editor, &.cm-editor.cm-focused": {
        backgroundColor: "transparent !important",
        color: "var(--foreground)",
        outline: "none",
        padding: "8px",
      },
      ".cm-scroller": {
        fontFamily: detectMonoFontFamily(),
        fontSize: "13px",
        lineHeight: "1.55",
        backgroundColor: "transparent !important",
      },
      ".cm-content": {
        caretColor: "var(--foreground)",
        backgroundColor: "transparent !important",
      },
      ".cm-gutters": {
        backgroundColor: "transparent !important",
        color: "var(--muted-foreground)",
      },
      ".cm-gutter-lint": {
        width: "0px",
      },
      ".cm-gutter": { backgroundColor: "transparent !important" },
      ".cm-lineNumbers .cm-gutterElement": {
        opacity: "0.55",
      },
      ".cm-foldGutter": { width: "10px" },
      ".cm-foldGutter .cm-gutterElement": {
        color: "var(--muted-foreground)",
        opacity: "0.5",
      },
      ".cm-activeLine": {
        borderTopRightRadius: "5px",
        borderBottomRightRadius: "5px",
        backgroundColor:
          "color-mix(in srgb, var(--foreground) 4%, transparent)",
      },
      ".cm-lineNumbers .cm-activeLineGutter": {
        borderTopLeftRadius: "5px",
        borderBottomLeftRadius: "5px",
        userSelect: "none",
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: "var(--foreground)",
      },
      // Vim normal-mode block cursor — translucent foreground, no rose hue.
      ".cm-fat-cursor": {
        background:
          "color-mix(in srgb, var(--foreground) 35%, transparent) !important",
        outline:
          "1px solid color-mix(in srgb, var(--foreground) 55%, transparent) !important",
        color: "var(--foreground) !important",
      },
      "&:not(.cm-focused) .cm-fat-cursor": {
        background: "transparent !important",
        outline:
          "1px solid color-mix(in srgb, var(--foreground) 35%, transparent) !important",
      },
      ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection":
        {
          backgroundColor:
            "color-mix(in srgb, var(--foreground) 18%, transparent) !important",
        },
      ".cm-panels": {
        backgroundColor: "var(--popover)",
        color: "var(--popover-foreground)",
        borderColor: "var(--border)",
      },

      // ── Autocomplete popup ───────────────────────────────────────────
      // The default xterm/CodeMirror tooltip clashes with the app chrome;
      // restyle it to match the popover surface with icons, type detail and
      // a documentation panel.
      ".cm-tooltip.cm-tooltip-autocomplete": {
        border: "1px solid var(--border)",
        borderRadius: "10px",
        backgroundColor: "var(--popover)",
        color: "var(--popover-foreground)",
        boxShadow:
          "0 10px 30px -8px rgba(0,0,0,0.45), 0 2px 8px -2px rgba(0,0,0,0.25)",
        overflow: "hidden",
        padding: "4px",
        backdropFilter: "blur(8px)",
      },
      ".cm-tooltip-autocomplete > ul": {
        fontFamily: detectMonoFontFamily(),
        fontSize: "12.5px",
        maxHeight: "16rem",
      },
      ".cm-tooltip-autocomplete > ul > li": {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        padding: "4px 8px",
        borderRadius: "6px",
        lineHeight: "1.5",
        color: "var(--popover-foreground)",
      },
      ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
        backgroundColor:
          "color-mix(in srgb, var(--foreground) 12%, transparent)",
        color: "var(--foreground)",
      },
      ".cm-completionLabel": {
        flex: "1 1 auto",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      ".cm-completionMatchedText": {
        textDecoration: "none",
        fontWeight: "700",
        color: "var(--primary, #7dd3fc)",
      },
      ".cm-completionDetail": {
        marginLeft: "auto",
        paddingLeft: "10px",
        fontStyle: "normal",
        fontSize: "11px",
        opacity: "0.6",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        maxWidth: "45%",
      },
      // Documentation side panel (LSP `info`).
      ".cm-tooltip.cm-completionInfo": {
        marginLeft: "6px",
        padding: "8px 10px",
        border: "1px solid var(--border)",
        borderRadius: "10px",
        backgroundColor: "var(--popover)",
        color: "var(--popover-foreground)",
        boxShadow: "0 10px 30px -8px rgba(0,0,0,0.45)",
        maxWidth: "360px",
        fontSize: "12px",
        lineHeight: "1.5",
      },
      // ── LSP hover tooltip ────────────────────────────────────────────
      ".cm-tooltip:has(.cm-lsp-hover)": {
        border: "1px solid var(--border)",
        borderRadius: "10px",
        backgroundColor: "var(--popover)",
        color: "var(--popover-foreground)",
        boxShadow: "0 10px 30px -8px rgba(0,0,0,0.45)",
        overflow: "hidden",
      },
      ".cm-lsp-hover": {
        maxWidth: "520px",
        maxHeight: "320px",
        overflow: "auto",
        padding: "8px 10px",
        fontSize: "12px",
        lineHeight: "1.5",
      },
      ".cm-lsp-hover-code": {
        margin: "0 0 4px",
        fontFamily: detectMonoFontFamily(),
        fontSize: "12px",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        color: "var(--foreground)",
      },
      ".cm-lsp-hover-doc": {
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        color: "var(--muted-foreground)",
      },
      ".cm-lsp-hover-doc:not(:last-child)": {
        marginBottom: "6px",
      },

      // Completion kind icons — colored glyphs per symbol kind.
      ".cm-completionIcon": {
        width: "1.2em",
        boxSizing: "content-box",
        textAlign: "center",
        opacity: "0.9",
        fontSize: "90%",
        paddingRight: "2px",
      },
      ".cm-completionIcon-function, .cm-completionIcon-method": {
        color: "#c084fc",
      },
      ".cm-completionIcon-class, .cm-completionIcon-interface": {
        color: "#f59e0b",
      },
      ".cm-completionIcon-variable, .cm-completionIcon-property": {
        color: "#60a5fa",
      },
      ".cm-completionIcon-keyword": {
        color: "#fb7185",
      },
      ".cm-completionIcon-namespace": {
        color: "#34d399",
      },

      // ── Minimap ──────────────────────────────────────────────────────
      ".cm-minimap-gutter": {
        backgroundColor: "transparent !important",
        borderLeft: "1px solid var(--border)",
      },
      ".cm-minimap-overlay": {
        backgroundColor:
          "color-mix(in srgb, var(--foreground) 10%, transparent) !important",
      },
      ".cm-minimap-overlay.cm-minimap-overlay-active": {
        backgroundColor:
          "color-mix(in srgb, var(--foreground) 16%, transparent) !important",
      },
    }),
  ];
}
