import type { TerminalSource } from "./useTerminalSession";

/**
 * Per-leaf stream source registry. A terminal leaf defaults to a local shell;
 * SSH leaves register their source here at tab-creation time so the pane mounts
 * against the right backend. Kept out of the persisted pane tree because remote
 * connections don't survive an app restart (the leaf falls back to local then).
 */
const sources = new Map<number, TerminalSource>();

export function setTerminalSource(leafId: number, source: TerminalSource): void {
  sources.set(leafId, source);
}

export function getTerminalSource(leafId: number): TerminalSource | undefined {
  return sources.get(leafId);
}

export function clearTerminalSource(leafId: number): void {
  sources.delete(leafId);
}
