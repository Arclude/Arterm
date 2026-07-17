import { invoke } from "@/platform/core";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { LspClient } from "./client";
import { type LanguageInfo, resolveServerConfig } from "./config";
import { pathToUri } from "./uri";

// One language server per (serverId, projectRoot). Servers start lazily on the
// first editor that needs them and shut down when the last one closes. Zero
// cost when no editor is open or LSP is disabled.

type Entry = { promise: Promise<LspClient | null>; refs: Set<string> };

const entries = new Map<string, Entry>();
const fileKeys = new Map<string, string>();
const rootCache = new Map<string, string>();

const ROOT_MARKERS = [
  ".git",
  "package.json",
  "tsconfig.json",
  "jsconfig.json",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "Cargo.toml",
  "go.mod",
  "go.work",
  ".clangd",
  "compile_commands.json",
];

async function pathExists(p: string): Promise<boolean> {
  try {
    await invoke("fs_stat", { path: p });
    return true;
  } catch {
    return false;
  }
}

export async function findProjectRoot(filePath: string): Promise<string> {
  const norm = filePath.replace(/\\/g, "/");
  const segs = norm.split("/");
  segs.pop();
  const fileDir = segs.join("/");
  const cached = rootCache.get(fileDir);
  if (cached) return cached;

  const chain = [...segs];
  while (chain.length > 0) {
    const dir = chain.join("/");
    for (const marker of ROOT_MARKERS) {
      if (await pathExists(`${dir}/${marker}`)) {
        rootCache.set(fileDir, dir);
        return dir;
      }
    }
    chain.pop();
  }
  const fallback = fileDir || norm;
  rootCache.set(fileDir, fallback);
  return fallback;
}

export async function acquire(
  filePath: string,
  info: LanguageInfo,
): Promise<LspClient | null> {
  const state = usePreferencesStore.getState();
  if (!state.lspEnabled) return null;
  const cfg = resolveServerConfig(info.serverId, state.lspServers ?? {});
  if (!cfg || cfg.enabled === false) return null;

  const root = await findProjectRoot(filePath);
  // Config signature in the key so an edited command/args spins up a fresh
  // server (and the editor's release/re-acquire disposes the stale one)
  // without a global reset race.
  const sig = `${cfg.command} ${cfg.args.join(" ")}`;
  const key = `${info.serverId}::${root}::${sig}`;

  let entry = entries.get(key);
  if (!entry) {
    entry = {
      refs: new Set(),
      promise: LspClient.create({
        serverId: info.serverId,
        command: cfg.command,
        args: cfg.args,
        rootPath: root,
        rootUri: pathToUri(root),
      }).catch((e) => {
        console.warn(`lsp: failed to start ${info.serverId}:`, e);
        entries.delete(key);
        return null;
      }),
    };
    entries.set(key, entry);
  }
  entry.refs.add(filePath);
  fileKeys.set(filePath, key);

  const client = await entry.promise;
  if (!client) {
    entry.refs.delete(filePath);
    fileKeys.delete(filePath);
    return null;
  }
  return client;
}

export function release(filePath: string): void {
  const key = fileKeys.get(filePath);
  if (!key) return;
  fileKeys.delete(filePath);
  const entry = entries.get(key);
  if (!entry) return;
  entry.refs.delete(filePath);
  if (entry.refs.size === 0) {
    entries.delete(key);
    void entry.promise.then((c) => c?.dispose());
  }
}

// Drop every running server. Used when LSP config changes (a server's command
// may have changed under an unchanged key) and on a fresh webview load.
export function resetAll(): void {
  const drained = [...entries.values()];
  entries.clear();
  fileKeys.clear();
  rootCache.clear();
  for (const entry of drained) {
    void entry.promise.then((c) => c?.dispose());
  }
}

// Reap servers orphaned by a previous frontend in this still-running process.
export async function stopOrphanedServers(): Promise<void> {
  try {
    await invoke("lsp_stop_all");
  } catch (e) {
    console.warn("lsp: stop_all failed:", e);
  }
}

export const lspManager = {
  acquire,
  release,
  resetAll,
  findProjectRoot,
  stopOrphanedServers,
};
