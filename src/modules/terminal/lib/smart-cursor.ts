import type { Terminal } from "@xterm/xterm";

/**
 * Claude Code-style pointer: an I-beam only where there is actual text, the
 * plain arrow over empty cells. xterm.js paints `cursor: text` across the
 * whole terminal rectangle, which reads as "the entire window is a text
 * field"; content-aware styling keeps the selection affordance exactly where
 * selecting does something. Shape only — plain left-drag still selects
 * everywhere, this never touches behavior.
 */

/**
 * Decide the pointer for one hovered cell. Pure — the mousemove handler feeds
 * it, the tests exercise it directly.
 *
 * When the running program tracks the mouse (SGR etc.), clicks belong to the
 * program, not to selection — the arrow says so, matching what xterm.js does
 * on its own for that state.
 */
export function cursorForCell(
  chars: string | undefined,
  mouseTracking: boolean,
): string {
  if (mouseTracking) return "default";
  return chars !== undefined && chars.trim() !== "" ? "text" : "default";
}

/** Map a pixel position inside the screen rect to a (col, row) cell. */
export function cellFromPixel(
  rect: { left: number; top: number; width: number; height: number },
  cols: number,
  rows: number,
  x: number,
  y: number,
): { col: number; row: number } | null {
  if (cols < 1 || rows < 1 || rect.width <= 0 || rect.height <= 0) return null;
  const col = Math.floor((x - rect.left) / (rect.width / cols));
  const row = Math.floor((y - rect.top) / (rect.height / rows));
  if (col < 0 || col >= cols || row < 0 || row >= rows) return null;
  return { col, row };
}

/**
 * Attach the content-aware pointer to a terminal's screen element. rAF-gated:
 * at most one buffer probe per frame, so hover costs nothing measurable.
 * Returns a detach function (slots live for the app's lifetime, but tests
 * clean up).
 */
export function attachSmartCursor(
  term: Terminal,
  screen: HTMLElement,
): () => void {
  let raf = 0;
  const onMove = (ev: MouseEvent): void => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const cell = cellFromPixel(
        screen.getBoundingClientRect(),
        term.cols,
        term.rows,
        ev.clientX,
        ev.clientY,
      );
      const buf = term.buffer.active;
      const chars = cell
        ? buf
            .getLine(buf.viewportY + cell.row)
            ?.getCell(cell.col)
            ?.getChars()
        : undefined;
      screen.style.cursor = cursorForCell(
        chars,
        term.modes.mouseTrackingMode !== "none",
      );
    });
  };
  const onLeave = (): void => {
    screen.style.cursor = "";
  };
  screen.addEventListener("mousemove", onMove);
  screen.addEventListener("mouseleave", onLeave);
  return () => {
    if (raf) cancelAnimationFrame(raf);
    screen.removeEventListener("mousemove", onMove);
    screen.removeEventListener("mouseleave", onLeave);
    screen.style.cursor = "";
  };
}
