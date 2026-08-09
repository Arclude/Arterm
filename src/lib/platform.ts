import { platform } from "@/platform/os";

const PLATFORM = (() => {
  try {
    return platform();
  } catch {
    return "";
  }
})();

export const IS_MAC = PLATFORM === "macos";
export const IS_LINUX = PLATFORM === "linux";
export const IS_WINDOWS = PLATFORM === "windows";

/** Electron kabuğu. Kabuğa özgü IPC/paketleme farkları içindir; render-motoru
 * workaround'ları IS_CHROMIUM okumalı — Electron Chromium'dur ama Chromium
 * olan tek kabuk o değildir (aşağıya bak). */
export const IS_ELECTRON_SHELL =
  typeof window !== "undefined" && window.artermBridge?.shell === "electron";

/**
 * Sayfayı çizen motor Chromium mu? Electron her zaman Chromium'dur; Tauri ise
 * webview'ı platformdan alır: Windows'ta WebView2 (Chromium), macOS'ta
 * WKWebView ve Linux'ta WebKitGTK (ikisi de WebKit). Motora bağlı workaround'lar
 * bunu okumalı — kabuğa bakmak Windows'u WebKit sanıp yalnızca WebKit'te
 * gereken geçici çözümleri Chromium'da çalıştırıyordu (bkz. rendererPool
 * repaintWebgl).
 */
export function detectChromiumEngine(
  shell: string | undefined,
  userAgent: string,
): boolean {
  if (shell === "electron") return true;
  // WebKitGTK ve WKWebView "AppleWebKit/605… Safari/605…" bildirir; "Chrome/"
  // token'ı yalnızca Chromium tabanlı motorlarda bulunur, WebView2 dahil.
  return /\bChrome\/\d/.test(userAgent);
}

export const IS_CHROMIUM = detectChromiumEngine(
  typeof window !== "undefined" ? window.artermBridge?.shell : undefined,
  typeof navigator !== "undefined" ? navigator.userAgent : "",
);

/** Custom window controls (min/max/close) are rendered by us only on
 * non-macOS platforms — macOS keeps the native traffic lights via the
 * overlay title bar. */
export const USE_CUSTOM_WINDOW_CONTROLS = !IS_MAC && PLATFORM !== "";

export const MOD_KEY = IS_MAC ? "⌘" : "Ctrl";
/** KeyBinding property name for the platform's primary modifier. */
export const MOD_PROP: "meta" | "ctrl" = IS_MAC ? "meta" : "ctrl";
export const CTRL_KEY = IS_MAC ? "⌃" : "Ctrl";
export const ALT_KEY = IS_MAC ? "⌥" : "Alt";
export const SHIFT_KEY = IS_MAC ? "⇧" : "Shift";
export const TAB_KEY = IS_MAC ? "⇥" : "Tab";
export const ENTER_KEY = IS_MAC ? "↵" : "Enter";

export const KEY_SEP = IS_MAC ? "" : "+";

export function fmtShortcut(...parts: string[]): string {
  return parts.join(KEY_SEP);
}
