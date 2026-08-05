import type { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it } from "vitest";
import {
  clipboardHasImage,
  mouseEncodingSequence,
  pasteAction,
} from "./rendererPool";

/**
 * Minimal fake of the `Terminal` surface mouseEncodingSequence touches: the
 * public `modes` API plus the private core mouse service it has to reach for
 * (xterm exposes the tracking mode but not the report encoding).
 */
function makeFakeTerm(
  tracking: string,
  activeEncoding: string | undefined,
): Terminal {
  return {
    modes: { mouseTrackingMode: tracking },
    _core: { coreMouseService: { activeEncoding } },
  } as unknown as Terminal;
}

describe("mouseEncodingSequence", () => {
  it("re-appends ?1006h for an SGR-encoded tracking session", () => {
    expect(mouseEncodingSequence(makeFakeTerm("vt200", "SGR"))).toBe(
      "\x1b[?1006h",
    );
  });

  it("re-appends ?1016h for SGR_PIXELS", () => {
    expect(mouseEncodingSequence(makeFakeTerm("any", "SGR_PIXELS"))).toBe(
      "\x1b[?1016h",
    );
  });

  it("emits nothing when tracking is off — a plain shell must not inherit a latched encoding", () => {
    expect(mouseEncodingSequence(makeFakeTerm("none", "SGR"))).toBe("");
  });

  it("emits nothing for the default (X10) encoding the serialize addon already round-trips", () => {
    expect(mouseEncodingSequence(makeFakeTerm("vt200", "DEFAULT"))).toBe("");
  });

  it("survives a core surface that lacks the private service", () => {
    const term = {
      modes: { mouseTrackingMode: "vt200" },
    } as unknown as Terminal;
    expect(mouseEncodingSequence(term)).toBe("");
  });
});

describe("pasteAction", () => {
  it("forwards the keystroke for an image, so the TUI agent reads the clipboard itself", () => {
    expect(pasteAction(true, "")).toBe("image");
  });

  it("prefers the image when the clipboard carries incidental text too", () => {
    // A screenshot tool often sets a filename alongside the bitmap; pasting that
    // text would drop the image with no way to ask for it back.
    expect(pasteAction(true, "/home/me/Pictures/shot.png")).toBe("image");
  });

  it("pastes text when there is no image", () => {
    expect(pasteAction(false, "hello")).toBe("text");
  });

  it("does nothing for an empty clipboard", () => {
    expect(pasteAction(false, "")).toBe("none");
  });
});

describe("clipboardHasImage", () => {
  const original = globalThis.window;
  const setWindow = (value: unknown) => {
    (globalThis as { window?: unknown }).window = value;
  };
  afterEach(() => {
    setWindow(original);
  });

  it("asks the Electron main process when the bridge exposes the probe", async () => {
    setWindow({ artermBridge: { clipboardHasImage: async () => true } });
    await expect(clipboardHasImage()).resolves.toBe(true);
  });

  it("reports no image rather than throwing when the probe fails", async () => {
    setWindow({
      artermBridge: {
        clipboardHasImage: async () => {
          throw new Error("ipc down");
        },
      },
    });
    await expect(clipboardHasImage()).resolves.toBe(false);
  });

  it("falls back to the webview clipboard API when no bridge probe exists", async () => {
    setWindow({});
    const navigatorRef = globalThis.navigator as unknown as {
      clipboard?: unknown;
    };
    const prior = navigatorRef.clipboard;
    navigatorRef.clipboard = {
      read: async () => [{ types: ["image/png"] }],
    };
    await expect(clipboardHasImage()).resolves.toBe(true);
    navigatorRef.clipboard = prior;
  });
});
