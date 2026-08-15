// The Alt+arrow pass-through keys off `term.buffer.active.type`, so this
// pins the assumption it rests on: xterm.js must actually report "alternate"
// once an app switches buffers. If that string ever changed, the pass-through
// would silently stop firing and the effort keys would look dead again --
// the failure and the fix are indistinguishable from the outside.
import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";

const ENTER_ALT_SCREEN = "\x1b[?1049h";
const LEAVE_ALT_SCREEN = "\x1b[?1049l";

const write = (term: Terminal, data: string) =>
  new Promise<void>((resolve) => term.write(data, resolve));

describe("alternate screen detection", () => {
  it("reports normal before, alternate after the buffer switch", async () => {
    const term = new Terminal({ allowProposedApi: true });
    expect(term.buffer.active.type).toBe("normal");

    await write(term, ENTER_ALT_SCREEN);
    expect(term.buffer.active.type).toBe("alternate");

    await write(term, LEAVE_ALT_SCREEN);
    expect(term.buffer.active.type).toBe("normal");
    term.dispose();
  });
});
