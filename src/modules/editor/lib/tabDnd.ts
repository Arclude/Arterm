// Shared state for editor-tab drag & drop. The MIME type marks our drags so
// drop zones can ignore unrelated drags; `draggedTabId` lets drop targets show
// live feedback during dragover (where dataTransfer payloads aren't readable).

export const TAB_MIME = "application/x-artex-editor-tab";

let dragged: number | null = null;

export function setDraggedTab(id: number | null): void {
  dragged = id;
}

export function getDraggedTab(): number | null {
  return dragged;
}

/** Given the dragover/drop clientX and a strip's tab elements (each tagged with
 * `data-tab-index`), return the insertion index. */
export function insertionIndex(
  clientX: number,
  container: HTMLElement,
): number {
  const tabs = Array.from(
    container.querySelectorAll<HTMLElement>("[data-tab-index]"),
  );
  for (let i = 0; i < tabs.length; i++) {
    const rect = tabs[i].getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) return i;
  }
  return tabs.length;
}
