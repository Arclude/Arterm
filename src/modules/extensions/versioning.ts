/**
 * Minimal version comparison for the marketplace update check. The repo has no
 * semver dependency and extension versions are simple dotted numbers
 * ("1.0.0", "1.2"), so a numeric segment compare is enough. Non-numeric
 * segments compare as 0 (best-effort, never throws).
 */
function parts(v: string): number[] {
  return v
    .trim()
    .split(".")
    .map((p) => {
      const n = Number.parseInt(p, 10);
      return Number.isFinite(n) ? n : 0;
    });
}

/** -1 if a < b, 0 if equal, 1 if a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

/** True when the registry offers a newer version than what is installed. */
export function isUpdateAvailable(
  installed: string | undefined,
  registry: string | undefined,
): boolean {
  if (!installed || !registry) return false;
  return compareVersions(registry, installed) > 0;
}
