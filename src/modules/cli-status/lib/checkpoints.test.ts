import { describe, expect, it } from "vitest";
import { rewindOutcome } from "./checkpoints";

describe("rewindOutcome", () => {
  it("classifies from the COUNTS, not from how the note is worded", () => {
    // The contract is a number. If the CLI rephrases its sentence tomorrow, a
    // partial restore must still read as partial — putting prose in charge of
    // that is the mistake `verify.ts` names outright.
    const partial = rewindOutcome({
      ok: true,
      rewind: { restored: 3, unchanged: 1, skippedLinks: 2 },
      detail: "put 3 files back; 2 links left alone",
    });
    expect(partial.kind).toBe("partial");

    const clean = rewindOutcome({
      ok: true,
      rewind: { restored: 3, unchanged: 1, skippedLinks: 0 },
      // Prose that MENTIONS skipping while the count says nothing was skipped:
      // the number wins.
      detail: "restored 3, nothing skipped",
    });
    expect(clean.kind).toBe("restored");
  });

  it("falls back to the prose only for a CLI that sends no counts", () => {
    const o = rewindOutcome({
      ok: true,
      detail: "restored 3, skipped 1 link(s)",
    });
    expect(o.kind).toBe("partial");
  });

  it("reads a clean restore as restored, verbatim", () => {
    const o = rewindOutcome({ ok: true, detail: "restored 3, unchanged 1" });
    expect(o.kind).toBe("restored");
    expect(o.text).toBe("restored 3, unchanged 1");
  });

  it("separates a partial restore from a clean one", () => {
    // The whole point: this must NOT read as a success. Files the restore could
    // not put back are still the agent's, and nothing else would say so.
    const o = rewindOutcome({
      ok: true,
      detail: "restored 3, unchanged 1, skipped 2 link(s)",
    });
    expect(o.kind).toBe("partial");
    expect(o.text).toContain("skipped 2 link(s)");
  });

  it("treats a detail-less success as a plain restore", () => {
    // An older CLI sends no detail; absent is not "something went unreported".
    expect(rewindOutcome({ ok: true })).toEqual({
      kind: "restored",
      text: "files restored",
    });
    expect(rewindOutcome({ ok: true, detail: "   " }).kind).toBe("restored");
  });

  it("surfaces the CLI's own error rather than a generic one", () => {
    expect(
      rewindOutcome({ ok: false, error: "no such checkpoint: nope" }),
    ).toEqual({ kind: "failed", text: "no such checkpoint: nope" });
  });

  it("still fails loudly when the CLI gave no reason", () => {
    expect(rewindOutcome({ ok: false }).kind).toBe("failed");
    expect(rewindOutcome({ ok: false }).text).not.toBe("");
  });

  it("never upgrades a failure that carries a detail", () => {
    // `ok: false` is the verdict; a chatty note beside it changes nothing.
    expect(
      rewindOutcome({ ok: false, error: "boom", detail: "restored 3" }).kind,
    ).toBe("failed");
  });
});
