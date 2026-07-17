// Shell abstraction layer: @tauri-apps imports live only under src/platform.
// Explicit exports below shadow the star re-export for the dispatched symbols.
import * as tauri from "@tauri-apps/api/app";
import * as electron from "./electron/app";

export * from "@tauri-apps/api/app";

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const getVersion: typeof tauri.getVersion = isTauri
  ? tauri.getVersion
  : (electron.getVersion as unknown as typeof tauri.getVersion);

export const getName: typeof tauri.getName = isTauri
  ? tauri.getName
  : (electron.getName as unknown as typeof tauri.getName);
