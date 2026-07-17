import { Channel, invoke } from "@/platform/core";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setLspServers } from "@/modules/settings/store";
import { assetFor, type InstallEntry } from "./installRegistry";
import { lspManager } from "./manager";

// Frontend controller for the Mason-style server installer. Drives the Rust
// lsp_install_* commands and, on success, points the existing LSP flow at the
// managed binary by writing its absolute path into the lspServers override
// (an absolute command bypasses PATH resolution in resolve_program).

export type DownloadProgress = { downloaded: number; total: number | null };

export type InstalledServer = {
  serverId: string;
  version: string;
  binPath: string;
};

/** Servers currently installed in the Arterm-managed directory. */
export function listInstalled(): Promise<InstalledServer[]> {
  return invoke<InstalledServer[]>("lsp_install_list");
}

/**
 * Download + install a server, then make the editor use it. Returns the
 * absolute path of the installed binary. `onProgress` reports byte progress
 * during download.
 */
export async function installServer(
  entry: InstallEntry,
  onProgress?: (p: DownloadProgress) => void,
): Promise<string> {
  const asset = assetFor(entry);
  if (!asset) {
    throw new Error(`No prebuilt ${entry.label} is available for this platform`);
  }

  const channel = new Channel<DownloadProgress>();
  if (onProgress) channel.onmessage = onProgress;

  const binPath = await invoke<string>("lsp_install_download", {
    serverId: entry.id,
    url: asset.url,
    archive: asset.archive,
    binName: asset.binName,
    version: entry.version,
    onProgress: channel,
  });

  // Point the existing acquire()/resolveServerConfig flow at the managed
  // binary, then drop running servers so the next file open re-spawns it.
  const current = usePreferencesStore.getState().lspServers ?? {};
  await setLspServers({
    ...current,
    [entry.id]: {
      command: binPath,
      args: current[entry.id]?.args ?? [],
      enabled: true,
    },
  });
  lspManager.resetAll();
  return binPath;
}

/** Remove a managed server and clear the override that pointed at it. */
export async function uninstallServer(serverId: string): Promise<void> {
  await invoke("lsp_install_uninstall", { serverId });
  const current = usePreferencesStore.getState().lspServers ?? {};
  if (current[serverId]) {
    const next = { ...current };
    delete next[serverId];
    await setLspServers(next);
  }
  lspManager.resetAll();
}
