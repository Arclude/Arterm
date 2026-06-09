// Split a file path into display segments relative to the workspace root.
// Falls back to the absolute path's segments when the file is outside the root
// (or no root is open).
export function relativizePath(
  fullPath: string,
  workspaceRoot: string | null,
): string[] {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const f = norm(fullPath);
  if (workspaceRoot) {
    const root = norm(workspaceRoot);
    if (
      root.length > 0 &&
      f.toLowerCase().startsWith(`${root.toLowerCase()}/`)
    ) {
      return f
        .slice(root.length + 1)
        .split("/")
        .filter(Boolean);
    }
  }
  return f.split("/").filter(Boolean);
}
