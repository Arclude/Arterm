// Shell abstraction layer: @tauri-apps imports live only under src/platform.
// Explicit export shadows the star re-export for the dispatched symbol.
import * as tauri from "@tauri-apps/plugin-process";
import * as electron from "./electron/process";

export * from "@tauri-apps/plugin-process";

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const relaunch: typeof tauri.relaunch = isTauri
  ? tauri.relaunch
  : (electron.relaunch as unknown as typeof tauri.relaunch);
