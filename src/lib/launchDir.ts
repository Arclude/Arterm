import { invoke } from "@tauri-apps/api/core";

let cached: string | undefined;
let explicit = false;

export async function initLaunchDir(): Promise<void> {
  const launch = await invoke<string | null>("get_launch_dir").catch(
    () => null,
  );
  explicit = launch != null;
  const dir =
    launch ?? (await invoke<string>("workspace_current_dir").catch(() => null));
  cached = dir ? dir.replace(/\\/g, "/") : undefined;
}

/** True when the app was started with an explicit directory argument
 * (`arterm <dir>`), as opposed to the workspace fallback. */
export function wasLaunchDirExplicit(): boolean {
  return explicit;
}

export function getLaunchDir(): string | undefined {
  return cached;
}
