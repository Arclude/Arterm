// Shell abstraction layer: @tauri-apps imports live only under src/platform.
// Explicit exports below shadow the star re-export for the symbols that need
// runtime dispatch between the Tauri and Electron shells.
import * as tauri from "@tauri-apps/plugin-os";
import * as electron from "./electron/os";

export * from "@tauri-apps/plugin-os";

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const platform: typeof tauri.platform = isTauri
  ? tauri.platform
  : (electron.platform as unknown as typeof tauri.platform);

export const arch: typeof tauri.arch = isTauri
  ? tauri.arch
  : (electron.arch as unknown as typeof tauri.arch);
