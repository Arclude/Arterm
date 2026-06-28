import { redo, undo } from "@codemirror/commands";
import {
  findNext,
  findPrevious,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import { type Extension, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { vim } from "@replit/codemirror-vim";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type LspClient,
  type LspGotoTarget,
  languageInfoForPath,
  acquire as lspAcquire,
  lspExtensions,
  release as lspRelease,
  pathToUri,
  uriToPath,
} from "@/modules/lsp";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  buildSharedExtensions,
  debugCompartment,
  languageCompartment,
  lspCompartment,
  mergeConflictCompartment,
  minimapCompartment,
  vimCompartment,
} from "./lib/extensions";
import { formatDocument } from "@/modules/lsp/codemirror/format";
import { offsetToPosition } from "@/modules/lsp/codemirror/position";
import { applyTextEditsToView } from "@/modules/lsp/codemirror/workspaceEdit";
import type { TextEdit } from "vscode-languageserver-protocol";
import { EditorBreadcrumb } from "./EditorBreadcrumb";
import { type AnySymbol, resolveSymbolPath } from "./lib/breadcrumbSymbols";
import { debugExtension } from "./lib/debugGutter";
import { mergeConflictExtension } from "./lib/mergeConflictExtension";
import { minimapExtension } from "./lib/minimap";
import { EDITOR_THEME_EXT } from "./lib/themes";
import { initVimGlobals, vimHandlersExtension } from "./lib/vim";

initVimGlobals();

import { getKey } from "@/modules/ai/lib/keyring";
import { onKeysChanged } from "@/modules/settings/store";
import { inlineCompletion } from "./lib/autocomplete/inlineExtension";
import { resolveLanguage } from "./lib/languageResolver";
import { useDocument } from "./lib/useDocument";

export type EditorPaneHandle = {
  setQuery: (q: string) => void;
  findNext: () => void;
  findPrevious: () => void;
  clearQuery: () => void;
  focus: () => void;
  getSelection: () => string | null;
  getPath: () => string;
  /** Re-read the file from disk. Skips silently if the buffer is dirty. */
  reload: () => boolean;
  /** Apply CodeMirror's undo/redo commands. */
  undo: () => void;
  redo: () => void;
  /** Apply LSP text edits to this pane's live buffer (rename, code actions). */
  applyLspEdits: (edits: TextEdit[]) => void;
};

type Props = {
  path: string;
  workspaceRoot?: string | null;
  onDirtyChange?: (dirty: boolean) => void;
  onSaved?: () => void;
  onClose?: () => void;
  /** Split this editor group (wired through to the breadcrumb buttons). */
  onSplit?: (dir: "row" | "col") => void;
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Beyond this size (in characters) the editor drops expensive,
// non-essential features — minimap (renders the whole document),
// selection-match highlighting (full-document scan) and AI inline completion
// — so typing and scrolling stay smooth on very large files.
const LARGE_FILE_CHARS = 500_000;

export const EditorPane = forwardRef<EditorPaneHandle, Props>(
  function EditorPane(
    { path, workspaceRoot, onDirtyChange, onSaved, onClose, onSplit },
    ref,
  ) {
    const { doc, onChange, save, reload } = useDocument({
      path,
      onDirtyChange,
    });

    // Heavy features are gated on this for big documents (see LARGE_FILE_CHARS).
    // Read inside extension callbacks via the ref so the (stable) extensions
    // array never changes identity.
    const isLarge =
      doc.status === "ready" && doc.content.length > LARGE_FILE_CHARS;
    const isLargeRef = useRef(isLarge);
    isLargeRef.current = isLarge;
    const reloadRef = useRef(reload);
    reloadRef.current = reload;
    const cmRef = useRef<ReactCodeMirrorRef>(null);
    // @uiw/react-codemirror creates the EditorView in a passive effect, so
    // cmRef.current.view is null on the first commit. Flip this once the view
    // exists to re-run effects that must dispatch into a live view.
    const [editorReady, setEditorReady] = useState(false);
    const editorThemeId = usePreferencesStore((s) => s.editorTheme);
    const vimMode = usePreferencesStore((s) => s.vimMode);
    const minimap = usePreferencesStore((s) => s.minimap);
    const lspEnabled = usePreferencesStore((s) => s.lspEnabled);
    const lspServers = usePreferencesStore((s) => s.lspServers);
    const lspServersKey = useMemo(
      () => JSON.stringify(lspServers),
      [lspServers],
    );
    const languageRef = useRef<string | null>(null);
    const apiKeyRef = useRef<string | null>(null);

    useEffect(() => {
      let cancelled = false;
      const refresh = async () => {
        const provider = usePreferencesStore.getState().autocompleteProvider;
        if (
          provider === "lmstudio" ||
          provider === "mlx" ||
          provider === "ollama"
        ) {
          apiKeyRef.current = null;
          return;
        }
        const k = await getKey(provider);
        if (!cancelled) apiKeyRef.current = k;
      };
      void refresh();
      let unlistenKeys: (() => void) | undefined;
      void onKeysChanged(() => void refresh()).then((un) => {
        unlistenKeys = un;
      });
      const unsubPrefs = usePreferencesStore.subscribe((state, prev) => {
        if (state.autocompleteProvider !== prev.autocompleteProvider) {
          void refresh();
        }
      });
      return () => {
        cancelled = true;
        unlistenKeys?.();
        unsubPrefs();
      };
    }, []);
    const themeExt =
      EDITOR_THEME_EXT[editorThemeId] ?? EDITOR_THEME_EXT.atomone;

    // Stabilize save + onSaved via refs so the extensions array never changes
    // identity — a new identity makes @uiw/react-codemirror reconfigure the
    // whole state, wiping the language compartment.
    const saveRef = useRef(save);
    saveRef.current = save;
    const onSavedRef = useRef(onSaved);
    onSavedRef.current = onSaved;
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    const pathRef = useRef(path);
    pathRef.current = path;

    // --- breadcrumb symbol path (cursor's enclosing symbol chain via LSP) ---
    const [symbolPath, setSymbolPath] = useState<string[]>([]);
    const lspClientRef = useRef<LspClient | null>(null);
    const symbolsRef = useRef<AnySymbol[] | null>(null);
    const symbolsStaleRef = useRef(true);
    const symbolTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Clear any pending symbol-resolution timer on unmount so a late callback
    // can't call setSymbolPath() after this pane is gone.
    useEffect(
      () => () => {
        if (symbolTimerRef.current) clearTimeout(symbolTimerRef.current);
      },
      [],
    );

    const resolveSymbols = useCallback(async (offset: number) => {
      const client = lspClientRef.current;
      const view = cmRef.current?.view;
      if (!client || !view || !client.capabilities?.documentSymbolProvider) {
        setSymbolPath([]);
        return;
      }
      if (symbolsStaleRef.current || symbolsRef.current == null) {
        try {
          const res = await client.request<AnySymbol[] | null>(
            "textDocument/documentSymbol",
            { textDocument: { uri: pathToUri(pathRef.current) } },
          );
          symbolsRef.current = res ?? [];
          symbolsStaleRef.current = false;
        } catch {
          symbolsRef.current = [];
        }
      }
      const pos = offsetToPosition(view.state.doc, offset);
      setSymbolPath(resolveSymbolPath(symbolsRef.current ?? [], pos));
    }, []);

    // Debounce cursor/edit events before resolving the symbol path.
    const cursorHandlerRef = useRef<
      (offset: number, docChanged: boolean) => void
    >(() => {});
    cursorHandlerRef.current = (offset, docChanged) => {
      if (docChanged) symbolsStaleRef.current = true;
      if (symbolTimerRef.current) clearTimeout(symbolTimerRef.current);
      symbolTimerRef.current = setTimeout(
        () => void resolveSymbols(offset),
        250,
      );
    };

    const extensions = useMemo(
      () => [
        // basicSetup is added before user extensions by @uiw/react-codemirror,
        // so we must elevate vim's precedence to win the keymap.
        vimCompartment.of(
          usePreferencesStore.getState().vimMode ? Prec.highest(vim()) : [],
        ),
        vimHandlersExtension(() => ({
          save: () => {
            void (async () => {
              await saveRef.current();
              onSavedRef.current?.();
            })();
          },
          close: () => onCloseRef.current?.(),
        })),
        ...buildSharedExtensions(),
        languageCompartment.of([]),
        lspCompartment.of([]),
        debugCompartment.of([]),
        mergeConflictCompartment.of([]),
        EditorView.updateListener.of((u) => {
          if (u.selectionSet || u.docChanged) {
            cursorHandlerRef.current(u.state.selection.main.head, u.docChanged);
          }
        }),
        // Built lazily by the minimap/language effects below (gated on file
        // size) rather than here, so a large document never pays the
        // full-document minimap build at EditorView creation.
        minimapCompartment.of([]),
        inlineCompletion({
          getPrefs: () => {
            const s = usePreferencesStore.getState();
            const p = s.autocompleteProvider;
            const modelId =
              p === "lmstudio"
                ? s.lmstudioModelId
                : p === "mlx"
                  ? s.mlxModelId
                  : p === "ollama"
                    ? s.ollamaModelId
                    : p === "openai-compatible"
                      ? s.openaiCompatibleModelId
                      : p === "openrouter"
                        ? s.openrouterModelId
                        : s.autocompleteModelId;
            return {
              enabled: s.autocompleteEnabled && !isLargeRef.current,
              provider: p,
              modelId,
              apiKey: apiKeyRef.current,
              lmstudioBaseURL: s.lmstudioBaseURL,
              mlxBaseURL: s.mlxBaseURL,
              ollamaBaseURL: s.ollamaBaseURL,
              openaiCompatibleBaseURL: s.openaiCompatibleBaseURL,
            };
          },
          getPath: () => pathRef.current,
          getLanguage: () => languageRef.current,
        }),
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: (view) => {
              void (async () => {
                // Format before saving when enabled and the server supports it.
                // formatDocument is a no-op (returns false) without a provider,
                // so a plain save still happens.
                if (usePreferencesStore.getState().formatOnSave) {
                  const client = lspClientRef.current;
                  if (client) {
                    try {
                      await formatDocument(
                        view,
                        client,
                        pathToUri(pathRef.current),
                      );
                    } catch {
                      // Ignore formatting errors and save anyway.
                    }
                  }
                }
                await saveRef.current();
                onSavedRef.current?.();
              })();
              return true;
            },
          },
          {
            key: "Shift-Alt-f",
            preventDefault: true,
            run: (view) => {
              const client = lspClientRef.current;
              if (!client) return false;
              void formatDocument(view, client, pathToUri(pathRef.current));
              return true;
            },
          },
        ]),
      ],
      [],
    );

    useEffect(() => {
      const view = cmRef.current?.view;
      if (!view) return;
      view.dispatch({
        effects: vimCompartment.reconfigure(vimMode ? Prec.highest(vim()) : []),
      });
    }, [vimMode]);

    useEffect(() => {
      const view = cmRef.current?.view;
      if (!view) return;
      view.dispatch({
        effects: minimapCompartment.reconfigure(
          minimap && !isLargeRef.current ? minimapExtension() : [],
        ),
      });
    }, [minimap]);

    // Breakpoint gutter + execution-line highlight. Enabled once the document
    // is a real text buffer; breakpoints persist in the debug store across
    // sessions, so the gutter works even with nothing running.
    useEffect(() => {
      if (doc.status !== "ready") return;
      const view = cmRef.current?.view;
      if (!view) return;
      view.dispatch({
        effects: debugCompartment.reconfigure(debugExtension(path)),
      });
      return () => {
        cmRef.current?.view?.dispatch({
          effects: debugCompartment.reconfigure([]),
        });
      };
    }, [path, doc.status, editorReady]);

    // Inline merge-conflict resolver (Accept Current/Incoming/Both). The
    // extension is inert until the document actually contains conflict markers,
    // so it can stay enabled for any real text buffer; gated off for huge files
    // where the per-edit line scan would add latency.
    useEffect(() => {
      if (doc.status !== "ready") return;
      const view = cmRef.current?.view;
      if (!view) return;
      view.dispatch({
        effects: mergeConflictCompartment.reconfigure(
          isLargeRef.current ? [] : mergeConflictExtension(),
        ),
      });
      return () => {
        cmRef.current?.view?.dispatch({
          effects: mergeConflictCompartment.reconfigure([]),
        });
      };
    }, [path, doc.status, editorReady]);

    useEffect(() => {
      let cancelled = false;
      const ext = path.split(".").pop()?.toLowerCase() ?? null;
      languageRef.current = ext;
      const resolve = async (): Promise<Extension> => {
        if (path.toLowerCase().endsWith(".arterm-theme")) {
          const [{ json }, { colorSwatches }] = await Promise.all([
            import("@codemirror/lang-json"),
            import("./lib/colorSwatches"),
          ]);
          return [json(), colorSwatches()];
        }
        return (await resolveLanguage(path)) ?? [];
      };
      void resolve().then((extension) => {
        if (cancelled) return;
        const view = cmRef.current?.view;
        if (!view) return;
        // The minimap samples token colors from the active highlighter when it
        // builds. Language (and thus syntax highlighting) loads async after the
        // editor mounts, so rebuild the minimap in the same transaction to pick
        // up the colors immediately instead of only after the first scroll/edit.
        const effects = [languageCompartment.reconfigure(extension)];
        if (usePreferencesStore.getState().minimap && !isLargeRef.current) {
          effects.push(minimapCompartment.reconfigure(minimapExtension()));
        }
        view.dispatch({ effects });
      });
      return () => {
        cancelled = true;
      };
    }, [path, doc.status]);

    // Attach a language server (completion, hover, go-to-definition,
    // diagnostics) for this file. Lazy: skipped entirely when LSP is off or no
    // server is configured for the file type. Re-runs when LSP config changes.
    useEffect(() => {
      if (!lspEnabled || doc.status !== "ready") return;
      const info = languageInfoForPath(path);
      if (!info) return;
      let cancelled = false;
      let active: LspClient | null = null;
      const uri = pathToUri(path);
      const normalizedPath = path.replace(/\\/g, "/").toLowerCase();

      const onGoto = (target: LspGotoTarget) => {
        const view = cmRef.current?.view;
        if (view && uriToPath(target.uri).toLowerCase() === normalizedPath) {
          const lineNo = Math.min(target.line + 1, view.state.doc.lines);
          const lineObj = view.state.doc.line(lineNo);
          const offset = Math.min(
            lineObj.from + target.character,
            view.state.doc.length,
          );
          view.dispatch({
            selection: { anchor: offset },
            scrollIntoView: true,
          });
          view.focus();
          return;
        }
        window.dispatchEvent(
          new CustomEvent("arterm:lsp-goto", {
            detail: {
              path: uriToPath(target.uri),
              line: target.line,
              character: target.character,
            },
          }),
        );
      };

      void (async () => {
        const client = await lspAcquire(path, info);
        if (cancelled || !client) return;
        active = client;
        lspClientRef.current = client;
        // New server for this file — refetch symbols on the next cursor settle.
        symbolsRef.current = null;
        symbolsStaleRef.current = true;
        cursorHandlerRef.current(
          cmRef.current?.view?.state.selection.main.head ?? 0,
          false,
        );
        const view = cmRef.current?.view;
        if (!view) return;
        client.didOpen(uri, info.languageId, view.state.doc.toString());
        view.dispatch({
          effects: lspCompartment.reconfigure(
            lspExtensions(client, uri, onGoto),
          ),
        });
      })();

      return () => {
        cancelled = true;
        active?.didClose(uri);
        lspClientRef.current = null;
        symbolsRef.current = null;
        symbolsStaleRef.current = true;
        setSymbolPath([]);
        // didClose + lspRelease must always run (server bookkeeping). The
        // compartment reconfigure is only meaningful when the view still
        // exists (deps changed, pane staying mounted); on a real unmount the
        // view is already gone and its state is discarded, so skipping the
        // dispatch is correct rather than a silent failure.
        const view = cmRef.current?.view;
        if (view) {
          view.dispatch({ effects: lspCompartment.reconfigure([]) });
        }
        lspRelease(path);
      };
    }, [path, doc.status, lspEnabled, lspServersKey]);

    useImperativeHandle(
      ref,
      () => ({
        setQuery: (q: string) => {
          const view = cmRef.current?.view;
          if (!view) return;
          view.dispatch({
            effects: setSearchQuery.of(
              new SearchQuery({ search: q, caseSensitive: false }),
            ),
          });
          if (q) findNext(view);
        },
        findNext: () => {
          const view = cmRef.current?.view;
          if (view) findNext(view);
        },
        findPrevious: () => {
          const view = cmRef.current?.view;
          if (view) findPrevious(view);
        },
        clearQuery: () => {
          const view = cmRef.current?.view;
          if (!view) return;
          view.dispatch({
            effects: setSearchQuery.of(new SearchQuery({ search: "" })),
          });
        },
        focus: () => {
          cmRef.current?.view?.focus();
        },
        getSelection: () => {
          const view = cmRef.current?.view;
          if (!view) return null;
          const { from, to } = view.state.selection.main;
          if (from === to) return null;
          return view.state.sliceDoc(from, to);
        },
        getPath: () => path,
        reload: () => reloadRef.current(),
        undo: () => {
          const view = cmRef.current?.view;
          if (view) undo(view);
        },
        redo: () => {
          const view = cmRef.current?.view;
          if (view) redo(view);
        },
        applyLspEdits: (edits: TextEdit[]) => {
          const view = cmRef.current?.view;
          if (view) applyTextEditsToView(view, edits);
        },
      }),
      [path],
    );

    if (doc.status === "loading") {
      return (
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
          Loading…
        </div>
      );
    }
    if (doc.status === "error") {
      return (
        <div className="flex h-full items-center justify-center px-6 text-center text-xs text-destructive">
          {doc.message}
        </div>
      );
    }
    if (doc.status === "image") {
      return (
        <div className="flex h-full min-h-0 items-center justify-center overflow-auto p-4">
          <img
            src={doc.dataUrl}
            alt={path}
            draggable={false}
            className="max-h-full max-w-full object-contain"
            style={{ imageRendering: "auto" }}
          />
        </div>
      );
    }
    if (doc.status === "binary") {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
          <div className="text-sm text-foreground">Binary file</div>
          <div className="text-xs text-muted-foreground">
            {formatBytes(doc.size)} · preview not supported
          </div>
        </div>
      );
    }
    if (doc.status === "toolarge") {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
          <div className="text-sm text-foreground">File too large</div>
          <div className="text-xs text-muted-foreground">
            {formatBytes(doc.size)} exceeds the {formatBytes(doc.limit)} limit.
          </div>
        </div>
      );
    }

    return (
      <div className="flex h-full min-h-0 flex-col">
        <EditorBreadcrumb
          path={path}
          workspaceRoot={workspaceRoot ?? null}
          symbolPath={symbolPath}
          onSplit={onSplit}
        />
        <CodeMirror
          ref={cmRef}
          onCreateEditor={() => setEditorReady(true)}
          value={doc.content}
          onChange={onChange}
          theme={themeExt}
          extensions={extensions}
          height="100%"
          className="flex-1 min-h-0 overflow-hidden"
          basicSetup={{
            lineNumbers: true,
            highlightActiveLineGutter: true,
            foldGutter: true,
            bracketMatching: true,
            closeBrackets: true,
            autocompletion: true,
            highlightActiveLine: true,
            // Off on large files: this scans the whole document on every
            // selection change.
            highlightSelectionMatches: !isLarge,
            searchKeymap: true,
          }}
        />
      </div>
    );
  },
);
