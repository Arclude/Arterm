import type { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { mouseEncodingSequence } from "./rendererPool";

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
