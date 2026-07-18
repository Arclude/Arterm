// Electron ucu: src/platform/electron/transport.ts bu yüzeyi okur ve Rust
// backend'ine (arterm-bridge sidecar) WebSocket ile bağlanır.
const { contextBridge, ipcRenderer } = require("electron");

const bridgeInfo = ipcRenderer.sendSync("arterm:bridge-info");
const appInfo = ipcRenderer.sendSync("arterm:app-info");
const paths = ipcRenderer.sendSync("arterm:paths");

contextBridge.exposeInMainWorld("artermBridge", {
  shell: "electron",
  bridgeInfo,
  /** { name, version } — @tauri-apps/api/app muadili için. */
  appInfo,
  /** { home, appConfig, download } — @tauri-apps/api/path muadili için. */
  paths,
  /** Pencere kontrolleri: "minimize" | "toggleMaximize" | "isMaximized" |
   *  "close" | "show" | "setFocus". isMaximized boolean döner. */
  winCtl: (action) => ipcRenderer.invoke("arterm:win", action),
  /** Tauri plugin-store dosya eşleniği: oku (yoksa null) / atomik yaz. */
  storeRead: (rel) => ipcRenderer.invoke("arterm:store-read", rel),
  storeWrite: (rel, contents) =>
    ipcRenderer.invoke("arterm:store-write", rel, contents),
  /** Ayarlar penceresini aç/odakla; { created } döner. */
  openSettings: (tab) => ipcRenderer.invoke("arterm:open-settings", tab),
  /** Yeni sürüm tanımı ya da null (kurulum biçimi desteklemiyorsa da null). */
  updateCheck: () => ipcRenderer.invoke("arterm:update-check"),
  /** Son check'in sonucunu indirir + kurar; ilerleme onUpdateProgress'ten akar. */
  updateInstall: () => ipcRenderer.invoke("arterm:update-install"),
  /** Progress dinleyicisi kaydeder; aboneliği iptal eden fonksiyon döner. */
  onUpdateProgress: (cb) => {
    const listener = (_e, p) => cb(p);
    ipcRenderer.on("arterm:update-progress", listener);
    return () => ipcRenderer.off("arterm:update-progress", listener);
  },
  relaunch: () => ipcRenderer.invoke("arterm:relaunch"),
  openExternal: (url) => ipcRenderer.invoke("arterm:open-external", url),
  openPath: (p) => ipcRenderer.invoke("arterm:open-path", p),
  revealItemInDir: (p) => ipcRenderer.invoke("arterm:reveal", p),
});
