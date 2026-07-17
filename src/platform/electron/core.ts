import { transport } from "./transport";

export { Channel } from "./transport";

export async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  // Window management is the Electron shell's job, not the headless bridge's:
  // route to the main process, mirroring Tauri's open_settings_window command.
  if (cmd === "open_settings_window") {
    const tab = (args?.tab as string | null | undefined) ?? null;
    const bridge = window.artermBridge;
    if (!bridge) throw new Error("artermBridge is unavailable");
    const { created } = await bridge.openSettings(tab);
    // Reused window: deliver the tab switch over the bridge event stream (a
    // fresh window reads it from the ?tab= query instead).
    if (!created && tab) await transport.emit("arterm:settings-tab", tab);
    return undefined as T;
  }
  return transport.invoke<T>(cmd, args);
}
