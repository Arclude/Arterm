// Shell abstraction layer: @tauri-apps imports live only under src/platform.
// Explicit export shadows the star re-export for the dispatched symbol.
import * as tauri from "@tauri-apps/plugin-store";
import * as electron from "./electron/store";

export * from "@tauri-apps/plugin-store";

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const LazyStore: typeof tauri.LazyStore = isTauri
  ? tauri.LazyStore
  : (electron.LazyStore as unknown as typeof tauri.LazyStore);
