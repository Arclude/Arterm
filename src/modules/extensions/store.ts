import { LazyStore } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import type { Theme } from "@/modules/theme/types";
import type { LoadedExtension } from "./types";

const STORE_PATH = "arterm-extensions.json";
const KEY_DISABLED = "disabled";
const KEY_REGISTRY_URL = "registryUrl";

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

/** User-overridden marketplace registry URL, or null to use the default. */
export async function getRegistryUrl(): Promise<string | null> {
  const v = await store.get<string>(KEY_REGISTRY_URL);
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export async function setRegistryUrl(url: string | null): Promise<void> {
  if (url && url.trim()) await store.set(KEY_REGISTRY_URL, url.trim());
  else await store.delete(KEY_REGISTRY_URL);
  await store.save();
}

/** Ids the user has turned off. Persisted across restarts. */
export async function getDisabledIds(): Promise<Set<string>> {
  const v = await store.get<string[]>(KEY_DISABLED);
  return new Set(Array.isArray(v) ? v : []);
}

export async function setExtensionEnabled(
  id: string,
  enabled: boolean,
): Promise<void> {
  const current = await getDisabledIds();
  if (enabled) current.delete(id);
  else current.add(id);
  await store.set(KEY_DISABLED, [...current]);
  await store.save();
}

type ExtensionsState = {
  loaded: boolean;
  extensions: LoadedExtension[];
  /** Themes contributed by currently-enabled extensions. */
  enabledThemes: Theme[];
  set: (extensions: LoadedExtension[], enabledThemes: Theme[]) => void;
};

export const useExtensionsStore = create<ExtensionsState>((set) => ({
  loaded: false,
  extensions: [],
  enabledThemes: [],
  set: (extensions, enabledThemes) =>
    set({ loaded: true, extensions, enabledThemes }),
}));
