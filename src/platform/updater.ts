// Shell abstraction layer: @tauri-apps imports live only under src/platform.
// Explicit export shadows the star re-export for the dispatched symbol.
import * as tauri from "@tauri-apps/plugin-updater";
import * as electron from "./electron/updater";

export * from "@tauri-apps/plugin-updater";

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const check: typeof tauri.check = isTauri
  ? tauri.check
  : (electron.check as unknown as typeof tauri.check);
