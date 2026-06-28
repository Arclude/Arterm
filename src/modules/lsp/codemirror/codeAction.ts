import type { Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import type {
  CodeAction,
  Command,
} from "vscode-languageserver-protocol";
import type { LspClient } from "../client";
import { getLspDiagnostics } from "./diagnostics";
import { offsetToPosition, positionToOffset } from "./position";
import {
  WORKSPACE_EDIT_EVENT,
  type WorkspaceEditDetail,
} from "./workspaceEdit";

// A code-action result item is either a bare Command (top-level `command` is a
// string) or a CodeAction (richer object whose `command`, if any, is nested).
type ActionItem = Command | CodeAction;

function isCommand(item: ActionItem): item is Command {
  return typeof (item as Command).command === "string";
}

async function fetchActions(
  client: LspClient,
  uri: string,
  view: EditorView,
): Promise<ActionItem[]> {
  const sel = view.state.selection.main;
  const doc = view.state.doc;
  // Diagnostics overlapping the selection give the server context for fixes.
  const diagnostics = getLspDiagnostics(uri).filter((d) => {
    const from = positionToOffset(doc, d.range.start);
    const to = positionToOffset(doc, d.range.end);
    return from <= sel.to && to >= sel.from;
  });
  const res = await client.request<ActionItem[] | null>(
    "textDocument/codeAction",
    {
      textDocument: { uri },
      range: {
        start: offsetToPosition(doc, sel.from),
        end: offsetToPosition(doc, sel.to),
      },
      context: { diagnostics },
    },
  );
  return res ?? [];
}

function dispatchEdit(edit: NonNullable<CodeAction["edit"]>): void {
  const detail: WorkspaceEditDetail = { edit };
  window.dispatchEvent(new CustomEvent(WORKSPACE_EDIT_EVENT, { detail }));
}

async function runAction(client: LspClient, item: ActionItem): Promise<void> {
  if (isCommand(item)) {
    await client.request("workspace/executeCommand", {
      command: item.command,
      arguments: item.arguments,
    });
    return;
  }

  let action = item;
  // Many servers return actions without an `edit` and expect a resolve round
  // trip to compute it lazily.
  const caps = client.capabilities?.codeActionProvider;
  const resolveProvider =
    typeof caps === "object" && caps !== null && "resolveProvider" in caps
      ? caps.resolveProvider
      : false;
  if (!action.edit && resolveProvider) {
    try {
      action = await client.request<CodeAction>("codeAction/resolve", action);
    } catch (e) {
      console.warn("[lsp] codeAction/resolve failed:", e);
    }
  }

  if (action.edit) dispatchEdit(action.edit);
  // A command may run on its own or alongside an edit (server may then issue a
  // workspace/applyEdit request, which the client handles centrally).
  if (action.command) {
    await client.request("workspace/executeCommand", {
      command: action.command.command,
      arguments: action.command.arguments,
    });
  }
}

// Floating selectable menu anchored at the cursor. Arrow keys move, Enter
// picks, Escape or an outside click dismisses. Captures keydown so it wins over
// the editor's own key handling while open.
function showActionMenu(
  view: EditorView,
  items: ActionItem[],
  onPick: (item: ActionItem) => void,
): void {
  const coords = view.coordsAtPos(view.state.selection.main.head);
  if (!coords) return;

  const menu = document.createElement("div");
  Object.assign(menu.style, {
    position: "fixed",
    left: `${coords.left}px`,
    top: `${coords.bottom + 2}px`,
    zIndex: "1000",
    minWidth: "12rem",
    maxWidth: "28rem",
    maxHeight: "16rem",
    overflowY: "auto",
    padding: "4px",
    font: "inherit",
    color: "var(--foreground)",
    background: "var(--popover, var(--background))",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
  } satisfies Partial<CSSStyleDeclaration>);

  let active = 0;
  const buttons: HTMLButtonElement[] = [];
  let done = false;

  const cleanup = () => {
    if (done) return;
    done = true;
    menu.remove();
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("mousedown", onOutside, true);
  };

  const setActive = (i: number) => {
    active = (i + items.length) % items.length;
    buttons.forEach((b, j) => {
      b.style.background =
        j === active ? "var(--accent, rgba(125,125,125,0.25))" : "transparent";
    });
    buttons[active]?.scrollIntoView({ block: "nearest" });
  };

  const pick = (item: ActionItem) => {
    cleanup();
    view.focus();
    onPick(item);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(active + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(active - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(items[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      cleanup();
      view.focus();
    }
    e.stopPropagation();
  };

  const onOutside = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) cleanup();
  };

  items.forEach((item, i) => {
    const b = document.createElement("button");
    b.textContent = item.title;
    Object.assign(b.style, {
      display: "block",
      width: "100%",
      textAlign: "left",
      padding: "3px 8px",
      border: "none",
      borderRadius: "4px",
      background: "transparent",
      color: "inherit",
      font: "inherit",
      cursor: "pointer",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
    } satisfies Partial<CSSStyleDeclaration>);
    b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      pick(item);
    });
    b.addEventListener("mousemove", () => setActive(i));
    menu.appendChild(b);
    buttons.push(b);
  });

  document.body.appendChild(menu);
  setActive(0);
  document.addEventListener("keydown", onKey, true);
  // Defer so the click that may have opened this doesn't immediately close it.
  setTimeout(() => document.addEventListener("mousedown", onOutside, true), 0);
}

// Ctrl/Cmd+. → request code actions for the selection and offer them in a menu.
export function lspCodeAction(client: LspClient, uri: string): Extension {
  return keymap.of([
    {
      key: "Mod-.",
      preventDefault: true,
      run: (view) => {
        if (!client.capabilities?.codeActionProvider) return false;
        void (async () => {
          try {
            const items = await fetchActions(client, uri, view);
            if (items.length === 0) return;
            showActionMenu(view, items, (item) =>
              void runAction(client, item).catch((e) =>
                console.warn("[lsp] code action failed:", e),
              ),
            );
          } catch (e) {
            console.warn("[lsp] codeAction request failed:", e);
          }
        })();
        return true;
      },
    },
  ]);
}
