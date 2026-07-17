// Shell abstraction layer: @tauri-apps imports live only under src/platform.
// Explicit exports below shadow the star re-export for the dispatched symbols.
import * as tauri from "@tauri-apps/api/path";
import * as electron from "./electron/path";

export * from "@tauri-apps/api/path";

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const appConfigDir: typeof tauri.appConfigDir = isTauri
  ? tauri.appConfigDir
  : (electron.appConfigDir as unknown as typeof tauri.appConfigDir);

export const homeDir: typeof tauri.homeDir = isTauri
  ? tauri.homeDir
  : (electron.homeDir as unknown as typeof tauri.homeDir);

export const downloadDir: typeof tauri.downloadDir = isTauri
  ? tauri.downloadDir
  : (electron.downloadDir as unknown as typeof tauri.downloadDir);

export const join: typeof tauri.join = isTauri
  ? tauri.join
  : (electron.join as unknown as typeof tauri.join);
