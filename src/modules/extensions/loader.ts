import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import type { Snippet } from "@/modules/ai/lib/snippets";
import { useSnippetsStore } from "@/modules/ai/store/snippetsStore";
import type { Theme } from "@/modules/theme/types";
import { emitExtensionsChanged } from "./events";
import { getDisabledIds, setExtensionEnabled, useExtensionsStore } from "./store";
import {
  type ContributedSnippet,
  type ExtensionManifest,
  EXT_THEME_PREFIX,
  type LoadedExtension,
  type RawExtension,
} from "./types";

export const HANDLE_RE = /^[a-z0-9][a-z0-9-]*$/;

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate the raw manifest JSON into a typed manifest (or throw a message). */
export function parseManifest(raw: unknown): ExtensionManifest {
  if (!isObj(raw)) throw new Error("manifest is not an object");
  const { id, name, version } = raw;
  if (typeof id !== "string" || !id.trim()) throw new Error("missing 'id'");
  if (typeof name !== "string" || !name.trim()) throw new Error("missing 'name'");
  if (typeof version !== "string") throw new Error("missing 'version'");
  return raw as ExtensionManifest;
}

/** Keep only well-formed themes and namespace their ids to avoid collisions. */
export function resolveThemes(manifest: ExtensionManifest): Theme[] {
  const out: Theme[] = [];
  for (const t of manifest.contributes?.themes ?? []) {
    if (!isObj(t) || typeof t.id !== "string" || typeof t.name !== "string") continue;
    if (!isObj(t.variants)) continue;
    out.push({ ...t, id: `${EXT_THEME_PREFIX}${manifest.id}:${t.id}` });
  }
  return out;
}

export function resolveSnippets(manifest: ExtensionManifest): Snippet[] {
  const out: Snippet[] = [];
  for (const s of manifest.contributes?.snippets ?? []) {
    const c = s as ContributedSnippet;
    if (!c || typeof c.handle !== "string" || !HANDLE_RE.test(c.handle)) continue;
    if (typeof c.content !== "string") continue;
    out.push({
      id: `${EXT_THEME_PREFIX}${manifest.id}:${c.handle}`,
      handle: c.handle,
      name: typeof c.name === "string" ? c.name : c.handle,
      description: typeof c.description === "string" ? c.description : "",
      content: c.content,
    });
  }
  return out;
}

/** Read all installed packages, validate, and publish their contributions. */
export async function loadExtensions(): Promise<void> {
  let raw: RawExtension[];
  try {
    raw = await invoke<RawExtension[]>("extensions_list");
  } catch (e) {
    console.error("[artex] extensions_list failed:", e);
    useExtensionsStore.getState().set([], []);
    return;
  }

  const disabled = await getDisabledIds();
  const extensions: LoadedExtension[] = [];
  const enabledThemes: Theme[] = [];
  const enabledSnippets: Snippet[] = [];

  for (const r of raw) {
    let manifest: ExtensionManifest | null = null;
    let error: string | null = r.error;
    if (r.manifest != null && error == null) {
      try {
        manifest = parseManifest(r.manifest);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }

    const themes = manifest ? resolveThemes(manifest) : [];
    const snippets = manifest ? resolveSnippets(manifest) : [];
    const enabled = manifest != null && !disabled.has(manifest.id);

    extensions.push({
      folder: r.folder,
      dir: r.dir,
      manifest,
      enabled,
      error,
      themeIds: themes.map((t) => t.id),
      snippetHandles: snippets.map((s) => s.handle),
    });

    if (enabled) {
      enabledThemes.push(...themes);
      enabledSnippets.push(...snippets);
    }
  }

  useExtensionsStore.getState().set(extensions, enabledThemes);
  useSnippetsStore.getState().setExtensionSnippets(enabledSnippets);
}

/** Reload this window's extension state and tell the other window to do the
 *  same. The single reload+broadcast path for every install/update/uninstall/
 *  toggle, so theme + snippet contributions propagate to both webviews. */
export async function reloadAfterInstall(): Promise<void> {
  await loadExtensions();
  await emitExtensionsChanged();
}

export async function toggleExtension(id: string, enabled: boolean): Promise<void> {
  await setExtensionEnabled(id, enabled);
  await reloadAfterInstall();
}

export async function uninstallExtension(folder: string): Promise<void> {
  await invoke("extensions_uninstall", { folder });
  await reloadAfterInstall();
}

export async function openExtensionsFolder(): Promise<void> {
  const dir = await invoke<string>("extensions_dir_path");
  await openPath(dir);
}

/** Install the bundled demo pack so users can see the system working at once. */
export async function installSampleExtension(): Promise<void> {
  await invoke("extensions_write", {
    id: SAMPLE_EXTENSION.id,
    manifest: JSON.stringify(SAMPLE_EXTENSION, null, 2),
  });
  await reloadAfterInstall();
}

/** A self-contained demo: one theme + one snippet, no code. */
const SAMPLE_EXTENSION: ExtensionManifest = {
  id: "artex.sample-pack",
  name: "Sample Pack",
  version: "1.0.0",
  author: "Artex",
  description: "Demo extension — adds an 'Midnight Ocean' theme and a /snippet.",
  engines: { artex: "^0.7.0" },
  permissions: [],
  contributes: {
    themes: [
      {
        id: "midnight-ocean",
        name: "Midnight Ocean",
        author: "Artex",
        description: "A deep blue dark theme from the sample extension.",
        variants: {
          dark: {
            colors: {
              background: "#0b1220",
              foreground: "#cdd9e5",
              primary: "#4cc9f0",
              accent: "#2a9d8f",
            },
            terminal: {
              background: "#0b1220",
              foreground: "#cdd9e5",
              cursor: "#4cc9f0",
              selection: "#1d3a5f",
              ansi: [
                "#1b2733", "#ff6b6b", "#7bdcb5", "#ffd166",
                "#4cc9f0", "#b39ddb", "#2a9d8f", "#cdd9e5",
                "#3a4a5a", "#ff8787", "#a0e8c8", "#ffe0a3",
                "#82dbff", "#d1c4e9", "#5fc7b8", "#ffffff",
              ],
            },
          },
        },
      },
    ],
    snippets: [
      {
        handle: "explain",
        name: "Explain this",
        description: "Ask the AI to explain the selected/last output.",
        content: "Explain what the following command output means, concisely:\n",
      },
    ],
  },
};
