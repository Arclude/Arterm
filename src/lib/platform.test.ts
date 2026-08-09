import { describe, expect, it } from "vitest";
import { detectChromiumEngine } from "./platform";

// Gerçek kabuklardan alınmış user-agent'lar. Motor tespiti bunlara bakar:
// kabuk (Electron/Tauri) ile motor (Chromium/WebKit) aynı şey değildir.
const UA = {
  electron:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Arterm/0.11.5 Chrome/140.0.0.0 Electron/43.1.0 Safari/537.36",
  webview2:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
  webkitGtk:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/8.0 Safari/605.1.15",
  wkWebView:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
};

describe("detectChromiumEngine", () => {
  it("treats the Electron shell as Chromium without consulting the UA", () => {
    expect(detectChromiumEngine("electron", "")).toBe(true);
  });

  it("detects WebView2 — the Tauri Windows webview is Chromium, not WebKit", () => {
    // Bu satırın regresyonu Windows'ta yalnızca WebKit'te gereken atlas
    // temizliğini çalıştırıp terminali bozulmuş gliflerle dolduruyordu.
    expect(detectChromiumEngine(undefined, UA.webview2)).toBe(true);
  });

  it("detects Electron's own UA when the bridge is not reachable", () => {
    expect(detectChromiumEngine(undefined, UA.electron)).toBe(true);
  });

  it("rejects WebKitGTK — Safari/AppleWebKit tokens are not Chromium", () => {
    expect(detectChromiumEngine(undefined, UA.webkitGtk)).toBe(false);
  });

  it("rejects WKWebView on macOS", () => {
    expect(detectChromiumEngine(undefined, UA.wkWebView)).toBe(false);
  });

  it("falls back to WebKit behaviour when there is no UA to read", () => {
    expect(detectChromiumEngine(undefined, "")).toBe(false);
  });
});
