// Shell abstraction layer: @tauri-apps imports live only under src/platform.
// Explicit export shadows the star re-export for the dispatched symbol.
import * as tauri from "@tauri-apps/api/window";
import * as electron from "./electron/window";

export * from "@tauri-apps/api/window";

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const getCurrentWindow: typeof tauri.getCurrentWindow = isTauri
  ? tauri.getCurrentWindow
  : (electron.getCurrentWindow as unknown as typeof tauri.getCurrentWindow);
