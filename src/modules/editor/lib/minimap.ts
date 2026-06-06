import { showMinimap } from "@replit/codemirror-minimap";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

// The minimap renders into a host element we own; the package handles drawing
// the document overview and the viewport overlay into it.
function create(_view: EditorView): { dom: HTMLElement } {
  const dom = document.createElement("div");
  dom.className = "artex-minimap-host";
  return { dom };
}

export function minimapExtension(): Extension {
  return showMinimap.compute([], () => ({
    create,
    // "blocks" reads as a clean code-shape overview; "characters" is noisier.
    displayText: "blocks",
    // Always show the viewport box so the map is useful at a glance.
    showOverlay: "always",
  }));
}
