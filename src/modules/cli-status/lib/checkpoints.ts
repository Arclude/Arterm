// Pure helpers for the rewind control. The interesting part is not the POST —
// it is reading the CLI's answer honestly, which is what `rewindOutcome` does.

import type { ControlResult } from "../types";

/**
 * How a rewind ended, as the UI needs to say it.
 *
 * `partial` exists because a restore that could not put everything back is NOT
 * a success with a footnote — it leaves the working tree in a state the user did
 * not ask for and would not otherwise know about. Collapsing it into `restored`
 * is the exact failure this feature exists to avoid.
 */
export type RewindOutcome = {
  kind: "restored" | "partial" | "failed";
  /** Verbatim from the CLI whenever it said anything — never a paraphrase. */
  text: string;
};

/**
 * Classify a `rewind` control response.
 *
 * `skippedLinks` is the contract: a number, so a change to how the CLI phrases
 * its note can never turn a partial restore into a clean-looking one. Reading
 * the prose instead would put a sentence on the far side of an IPC boundary in
 * charge of correctness here — the mistake `verify.ts` names outright.
 *
 * The `detail` regex below is the compatibility path ONLY, for a CLI old enough
 * to send prose and no counts. It is a fallback, not the rule.
 *
 * A missing `detail` on success is not suspicious — it reads as a plain restore
 * rather than an unknown.
 */
export function rewindOutcome(result: ControlResult): RewindOutcome {
  if (!result.ok) {
    return { kind: "failed", text: result.error ?? "the rewind failed" };
  }
  const detail = result.detail?.trim();
  if (result.rewind) {
    const { restored, unchanged, skippedLinks } = result.rewind;
    return {
      kind: skippedLinks > 0 ? "partial" : "restored",
      text:
        detail ||
        [
          `restored ${restored}`,
          `unchanged ${unchanged}`,
          ...(skippedLinks > 0 ? [`skipped ${skippedLinks} link(s)`] : []),
        ].join(", "),
    };
  }
  if (!detail) return { kind: "restored", text: "files restored" };
  return {
    kind: /\bskipped\b/i.test(detail) ? "partial" : "restored",
    text: detail,
  };
}

/** Palette colour per outcome, so a partial restore never wears the green of a
 *  clean one. `--cli-await` is the "needs a human" colour the permission prompt
 *  already uses, which is exactly what a partial restore is. */
export const REWIND_COLOR_VAR: Record<RewindOutcome["kind"], string> = {
  restored: "var(--cli-run)",
  partial: "var(--cli-await)",
  failed: "var(--cli-fail)",
};

/** Leading glyph per outcome, matching the transcript's ✔/⚠/✘ vocabulary. */
export const REWIND_GLYPH: Record<RewindOutcome["kind"], string> = {
  restored: "✔",
  partial: "⚠",
  failed: "✘",
};
