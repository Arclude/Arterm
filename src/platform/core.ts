// Shell abstraction layer: @tauri-apps imports live only under src/platform.
// Under the Electron shell the WebSocket bridge stands in for invoke/Channel;
// under Tauri the real bindings are used. Explicit exports below shadow the
// star re-export for the two symbols that need runtime dispatch.
import * as tauri from "@tauri-apps/api/core";
import * as electron from "./electron/core";

export * from "@tauri-apps/api/core";

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const invoke: typeof tauri.invoke = isTauri
  ? tauri.invoke
  : (electron.invoke as typeof tauri.invoke);

export const Channel: typeof tauri.Channel = isTauri
  ? tauri.Channel
  : (electron.Channel as unknown as typeof tauri.Channel);
