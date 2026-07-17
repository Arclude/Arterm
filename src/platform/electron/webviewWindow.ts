import { listen } from "./event";

/**
 * The Electron shell has a single webview window, so this collapses onto the
 * bridge event stream plus preload window control.
 */
export function getCurrentWebviewWindow() {
  return {
    listen,
    async setFocus(): Promise<void> {
      await window.artermBridge?.winCtl("setFocus");
    },
    async show(): Promise<void> {
      await window.artermBridge?.winCtl("show");
    },
  };
}
