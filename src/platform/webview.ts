// Shell abstraction layer: @tauri-apps imports live only under src/platform.
// Explicit export shadows the star re-export for the dispatched symbol.
import * as tauri from "@tauri-apps/api/webview";
import * as electron from "./electron/webview";

export * from "@tauri-apps/api/webview";

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const getCurrentWebview: typeof tauri.getCurrentWebview = isTauri
  ? tauri.getCurrentWebview
  : (electron.getCurrentWebview as unknown as typeof tauri.getCurrentWebview);
