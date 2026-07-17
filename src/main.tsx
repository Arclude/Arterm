import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import "@fontsource/jetbrains-mono/cyrillic-400.css";
import "@fontsource/jetbrains-mono/cyrillic-700.css";
import "@xterm/xterm/css/xterm.css";
import "./styles/globals.css";

import { invoke } from "@/platform/core";
import { getCurrentWindow } from "@/platform/window";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import { initLaunchDir } from "./lib/launchDir";
import { USE_CUSTOM_WINDOW_CONTROLS } from "./lib/platform";
import { initSessionRestore } from "./modules/session/persistence";

if (USE_CUSTOM_WINDOW_CONTROLS) {
  document.documentElement.dataset.chrome = "borderless";
}

// Reap PTY sessions orphaned by a prior webview load before any tab spawns.
await invoke("pty_close_all").catch(() => {});

// Seed before first paint so default tab mounts at target cwd (no flicker).
await initLaunchDir();

// Saved session must be in hand before first render — useTabs hydrates its
// initial state from it. Must run after initLaunchDir (explicit dir wins).
await initSessionRestore();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);

// Visible dev-build marker: the installed release binary looks identical, and
// GUI testing against the wrong one has burned us before. Dev builds only.
if (import.meta.env.DEV) {
  const badge = document.createElement("div");
  badge.textContent = "DEV BUILD";
  badge.style.cssText =
    "position:fixed;bottom:4px;right:8px;z-index:2147483647;pointer-events:none;" +
    "font:bold 11px monospace;color:#fff;background:#c0392b;padding:2px 6px;border-radius:4px;";
  document.body.appendChild(badge);
}

// Window starts hidden (per tauri.conf.json) so users never see a transparent
// shadow-only frame before React paints. Use setTimeout — rAF is throttled
// while the window is hidden and would never fire.
const showWindow = () => {
  // Electron shell: no Tauri window internals; main.cjs shows on ready-to-show.
  if (!("__TAURI_INTERNALS__" in window)) return;
  getCurrentWindow()
    .show()
    .catch((e) => console.error("window.show failed:", e));
};
setTimeout(showWindow, 50);
// Safety net: if the first show somehow fails to take effect, force again.
setTimeout(showWindow, 500);
