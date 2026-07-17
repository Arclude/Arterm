// Shell abstraction layer: @tauri-apps imports live only under src/platform.
// Explicit export shadows the star re-export for the dispatched symbol.
import * as tauri from "@tauri-apps/api/webviewWindow";
import * as electron from "./electron/webviewWindow";

export * from "@tauri-apps/api/webviewWindow";

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const getCurrentWebviewWindow: typeof tauri.getCurrentWebviewWindow =
  isTauri
    ? tauri.getCurrentWebviewWindow
    : (electron.getCurrentWebviewWindow as unknown as typeof tauri.getCurrentWebviewWindow);
