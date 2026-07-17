// Shell abstraction layer: @tauri-apps imports live only under src/platform.
// Explicit exports below shadow the star re-export for the dispatched symbols.
import * as tauri from "@tauri-apps/plugin-notification";
import * as electron from "./electron/notification";

export * from "@tauri-apps/plugin-notification";

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const isPermissionGranted: typeof tauri.isPermissionGranted = isTauri
  ? tauri.isPermissionGranted
  : (electron.isPermissionGranted as unknown as typeof tauri.isPermissionGranted);

export const requestPermission: typeof tauri.requestPermission = isTauri
  ? tauri.requestPermission
  : (electron.requestPermission as unknown as typeof tauri.requestPermission);

export const sendNotification: typeof tauri.sendNotification = isTauri
  ? tauri.sendNotification
  : (electron.sendNotification as unknown as typeof tauri.sendNotification);
