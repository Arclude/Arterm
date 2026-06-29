import {
  EditorSelection,
  type Extension,
  type SelectionRange,
} from "@codemirror/state";
import { type Command, EditorView, keymap } from "@codemirror/view";

/**
 * Add a cursor on the line above (dir -1) or below (dir +1) each existing
 * selection range, keeping the same logical column. Mirrors VS Code's
 * "Add Cursor Above/Below" (Ctrl+Alt+Up / Ctrl+Alt+Down). Interior cursors
 * dedupe against existing ones, so repeated presses extend the frontier.
 */
function addCursorVertically(dir: -1 | 1): Command {
  return (view: EditorView) => {
    const { state } = view;
    const existing = state.selection.ranges;
    const added: SelectionRange[] = [];
    for (const r of existing) {
      const line = state.doc.lineAt(r.head);
      const col = r.head - line.from;
      const targetNo = line.number + dir;
      if (targetNo < 1 || targetNo > state.doc.lines) continue;
      const target = state.doc.line(targetNo);
      added.push(
        EditorSelection.cursor(Math.min(target.from + col, target.to)),
      );
    }
    if (added.length === 0) return false;
    const ranges = [...existing, ...added];
    view.dispatch({
      selection: EditorSelection.create(ranges, ranges.length - 1),
      scrollIntoView: true,
    });
    return true;
  };
}

/**
 * Select every occurrence of the current selection (or the word under the
 * cursor when the selection is empty) across the whole document. Mirrors VS
 * Code's "Select All Occurrences" (Ctrl+Shift+L). Case-sensitive plain match.
 */
const selectAllOccurrences: Command = (view: EditorView) => {
  const { state } = view;
  let range: SelectionRange = state.selection.main;
  if (range.empty) {
    const word = state.wordAt(range.head);
    if (!word) return false;
    range = word;
  }
  const query = state.sliceDoc(range.from, range.to);
  if (!query) return false;
  const text = state.doc.toString();
  const ranges: SelectionRange[] = [];
  let idx = text.indexOf(query);
  while (idx !== -1) {
    ranges.push(EditorSelection.range(idx, idx + query.length));
    idx = text.indexOf(query, idx + query.length);
  }
  if (ranges.length === 0) return false;
  view.dispatch({
    selection: EditorSelection.create(ranges, ranges.length - 1),
    scrollIntoView: true,
  });
  return true;
};

/** Multi-cursor keybindings beyond CodeMirror's defaults (Mod-d is built in). */
export function multiCursorKeymap(): Extension {
  return keymap.of([
    {
      key: "Mod-Alt-ArrowUp",
      run: addCursorVertically(-1),
      preventDefault: true,
    },
    {
      key: "Mod-Alt-ArrowDown",
      run: addCursorVertically(1),
      preventDefault: true,
    },
    { key: "Mod-Shift-l", run: selectAllOccurrences, preventDefault: true },
  ]);
}
