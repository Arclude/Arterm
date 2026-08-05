import { describe, expect, it } from "vitest";
import { cellFromPixel, cursorForCell } from "./smart-cursor";

describe("cursorForCell — I-beam only where selecting means something", () => {
  it("shows the text cursor over real content", () => {
    expect(cursorForCell("m", false)).toBe("text");
    expect(cursorForCell("╭", false)).toBe("text");
  });

  it("shows the arrow over empty and whitespace cells", () => {
    expect(cursorForCell(undefined, false)).toBe("default");
    expect(cursorForCell("", false)).toBe("default");
    expect(cursorForCell(" ", false)).toBe("default");
  });

  it("always shows the arrow while the program tracks the mouse", () => {
    // Clicks belong to the program then, not to selection — an I-beam would
    // promise a selection that will not happen.
    expect(cursorForCell("m", true)).toBe("default");
  });
});

describe("cellFromPixel", () => {
  const rect = { left: 100, top: 50, width: 800, height: 480 };

  it("maps a pixel to its cell", () => {
    // 80 cols → 10px/col; 24 rows → 20px/row.
    expect(cellFromPixel(rect, 80, 24, 100, 50)).toEqual({ col: 0, row: 0 });
    expect(cellFromPixel(rect, 80, 24, 355, 271)).toEqual({ col: 25, row: 11 });
    expect(cellFromPixel(rect, 80, 24, 899, 529)).toEqual({ col: 79, row: 23 });
  });

  it("rejects positions outside the grid and degenerate rects", () => {
    expect(cellFromPixel(rect, 80, 24, 99, 60)).toBeNull();
    expect(cellFromPixel(rect, 80, 24, 901, 60)).toBeNull();
    expect(cellFromPixel({ ...rect, width: 0 }, 80, 24, 100, 50)).toBeNull();
    expect(cellFromPixel(rect, 0, 24, 100, 50)).toBeNull();
  });
});
