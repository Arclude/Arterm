import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Cross-window signal that the installed-extension set changed (install,
 * update, uninstall, enable/disable). The settings page is a separate webview,
 * so an in-memory store update in one window never reaches the other — mirror
 * every change through a Tauri event so both windows reload. Same pattern as
 * `customThemes.ts` CHANGED_EVENT and `settings/store.ts` PREFS_CHANGED_EVENT.
 */
export const EXTENSIONS_CHANGED_EVENT = "arterm://extensions-changed";

export async function emitExtensionsChanged(): Promise<void> {
  await emit(EXTENSIONS_CHANGED_EVENT);
}

export async function onExtensionsChange(cb: () => void): Promise<UnlistenFn> {
  return listen(EXTENSIONS_CHANGED_EVENT, () => cb());
}
