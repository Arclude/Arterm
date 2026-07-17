// Shell abstraction layer: @tauri-apps imports live only under src/platform.
// Under the Electron shell events flow over the WebSocket bridge; under Tauri
// the real bindings are used. Explicit exports below shadow the star re-export
// for the symbols that need runtime dispatch.
import * as tauri from "@tauri-apps/api/event";
import * as electron from "./electron/event";

export * from "@tauri-apps/api/event";

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const listen: typeof tauri.listen = isTauri
  ? tauri.listen
  : (electron.listen as unknown as typeof tauri.listen);

export const emit: typeof tauri.emit = isTauri
  ? tauri.emit
  : (electron.emit as unknown as typeof tauri.emit);
