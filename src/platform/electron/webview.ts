type UnlistenFn = () => void;

type DragDropPayload =
  | { type: "enter" | "over"; position: { x: number; y: number } }
  | { type: "leave" }
  | { type: "drop"; position: { x: number; y: number }; paths: string[] };

type DragDropEvent = { payload: DragDropPayload };

function isFileDrag(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}

/**
 * DOM-based mirror of Tauri's `onDragDropEvent`: window-level drag listeners
 * mapped onto the same payload shape. File paths come from the preload's
 * `pathForFile` (webUtils.getPathForFile) since `File.path` is gone in
 * Electron 32+. `preventDefault` on dragover/drop also stops Chromium from
 * navigating the window to a dropped file.
 */
export function getCurrentWebview() {
  return {
    onDragDropEvent: async (
      handler: (event: DragDropEvent) => void,
    ): Promise<UnlistenFn> => {
      const onDragEnter = (e: DragEvent) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        handler({
          payload: { type: "enter", position: { x: e.clientX, y: e.clientY } },
        });
      };
      const onDragOver = (e: DragEvent) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        handler({
          payload: { type: "over", position: { x: e.clientX, y: e.clientY } },
        });
      };
      const onDragLeave = (e: DragEvent) => {
        // relatedTarget is null only when the drag exits the window, not when
        // it crosses between elements inside it.
        if (e.relatedTarget !== null) return;
        handler({ payload: { type: "leave" } });
      };
      const onDrop = (e: DragEvent) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        const pathForFile = window.artermBridge?.pathForFile;
        const paths = Array.from(e.dataTransfer?.files ?? [])
          .map((file) => (pathForFile ? pathForFile(file) : ""))
          .filter(Boolean);
        handler({
          payload: {
            type: "drop",
            position: { x: e.clientX, y: e.clientY },
            paths,
          },
        });
      };
      window.addEventListener("dragenter", onDragEnter);
      window.addEventListener("dragover", onDragOver);
      window.addEventListener("dragleave", onDragLeave);
      window.addEventListener("drop", onDrop);
      return () => {
        window.removeEventListener("dragenter", onDragEnter);
        window.removeEventListener("dragover", onDragOver);
        window.removeEventListener("dragleave", onDragLeave);
        window.removeEventListener("drop", onDrop);
      };
    },
  };
}
