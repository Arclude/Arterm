type UnlistenFn = () => void;

/**
 * Native file drag-and-drop is not wired through the Electron bridge yet;
 * `onDragDropEvent` returns a no-op unlisten so callers register cleanly.
 */
export function getCurrentWebview() {
  return {
    onDragDropEvent: async (_handler?: unknown): Promise<UnlistenFn> => () => {},
  };
}
