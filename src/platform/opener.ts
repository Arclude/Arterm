// Shell abstraction layer: @tauri-apps imports live only under src/platform.
// Explicit exports below shadow the star re-export for the dispatched symbols.
import * as tauri from "@tauri-apps/plugin-opener";
import * as electron from "./electron/opener";

export * from "@tauri-apps/plugin-opener";

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const openUrl: typeof tauri.openUrl = isTauri
  ? tauri.openUrl
  : (electron.openUrl as unknown as typeof tauri.openUrl);

export const openPath: typeof tauri.openPath = isTauri
  ? tauri.openPath
  : (electron.openPath as unknown as typeof tauri.openPath);

export const revealItemInDir: typeof tauri.revealItemInDir = isTauri
  ? tauri.revealItemInDir
  : (electron.revealItemInDir as unknown as typeof tauri.revealItemInDir);
