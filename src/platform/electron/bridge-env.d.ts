export {};

type WinCtlAction =
  | "minimize"
  | "toggleMaximize"
  | "isMaximized"
  | "close"
  | "show"
  | "setFocus";

declare global {
  interface Window {
    /**
     * Injected by the Electron preload script. Absent under the Tauri shell.
     * `bridgeInfo.url` is a bare `ws://127.0.0.1:PORT`; the transport appends
     * the bridge path and token when connecting.
     */
    artermBridge?: {
      shell: "electron";
      bridgeInfo: { url: string; token: string };
      appInfo: { name: string; version: string };
      paths: { home: string; appConfig: string; download: string };
      winCtl: (action: WinCtlAction) => Promise<unknown>;
      openSettings: (tab: string | null) => Promise<{ created: boolean }>;
      storeRead: (rel: string) => Promise<string | null>;
      storeWrite: (rel: string, contents: string) => Promise<void>;
      openExternal: (url: string) => Promise<void>;
      openPath: (path: string) => Promise<void>;
      revealItemInDir: (path: string) => Promise<void>;
    };
  }
}
