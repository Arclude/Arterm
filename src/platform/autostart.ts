// Shell abstraction layer: @tauri-apps imports live only under src/platform.
// Explicit exports below shadow the star re-export for the dispatched symbols.
import * as tauri from "@tauri-apps/plugin-autostart";
import * as electron from "./electron/autostart";

export * from "@tauri-apps/plugin-autostart";

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const enable: typeof tauri.enable = isTauri
  ? tauri.enable
  : (electron.enable as unknown as typeof tauri.enable);

export const disable: typeof tauri.disable = isTauri
  ? tauri.disable
  : (electron.disable as unknown as typeof tauri.disable);

export const isEnabled: typeof tauri.isEnabled = isTauri
  ? tauri.isEnabled
  : (electron.isEnabled as unknown as typeof tauri.isEnabled);
