import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import type { Snippet } from "@/modules/ai/lib/snippets";
import { useSnippetsStore } from "@/modules/ai/store/snippetsStore";
import type { Theme } from "@/modules/theme/types";
import { emitExtensionsChanged } from "./events";
import {
  type ExtensionCommand,
  type ExtensionRuntime,
  extensionHost,
  useExtensionCommandsStore,
} from "./host";
import {
  getDisabledIds,
  setExtensionEnabled,
  useExtensionsStore,
} from "./store";
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
  if (typeof name !== "string" || !name.trim())
    throw new Error("missing 'name'");
  if (typeof version !== "string") throw new Error("missing 'version'");
  return raw as ExtensionManifest;
}

/** Keep only well-formed themes and namespace their ids to avoid collisions. */
export function resolveThemes(manifest: ExtensionManifest): Theme[] {
  const out: Theme[] = [];
  for (const t of manifest.contributes?.themes ?? []) {
    if (!isObj(t) || typeof t.id !== "string" || typeof t.name !== "string")
      continue;
    if (!isObj(t.variants)) continue;
    out.push({ ...t, id: `${EXT_THEME_PREFIX}${manifest.id}:${t.id}` });
  }
  return out;
}

export function resolveSnippets(manifest: ExtensionManifest): Snippet[] {
  const out: Snippet[] = [];
  for (const s of manifest.contributes?.snippets ?? []) {
    const c = s as ContributedSnippet;
    if (!c || typeof c.handle !== "string" || !HANDLE_RE.test(c.handle))
      continue;
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

/** Command ids: dotted lowercase segments, e.g. "hello.world". */
const COMMAND_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/;

/** An extension is executable when it ships entry code (a `main` file or
 *  inline `mainSource`). Only then are its `contributes.commands` live. */
export function isExecutable(manifest: ExtensionManifest): boolean {
  return (
    typeof manifest.main === "string" || typeof manifest.mainSource === "string"
  );
}

/** Resolve an executable extension's entry source: inline `mainSource`, or the
 *  `main` file read from the extension folder on disk. Null when neither
 *  yields usable code. */
export async function resolveSource(
  folder: string,
  manifest: ExtensionManifest,
): Promise<string | null> {
  if (typeof manifest.mainSource === "string") return manifest.mainSource;
  if (typeof manifest.main === "string") {
    try {
      return await invoke<string>("extensions_read_file", {
        folder,
        file: manifest.main,
      });
    } catch (e) {
      console.error(
        `[arterm] failed reading ${manifest.id}/${manifest.main}:`,
        e,
      );
      return null;
    }
  }
  return null;
}

/** Keep only well-formed contributed commands for an executable extension. */
export function resolveCommands(
  manifest: ExtensionManifest,
): ExtensionCommand[] {
  if (!isExecutable(manifest)) return [];
  const out: ExtensionCommand[] = [];
  for (const c of manifest.contributes?.commands ?? []) {
    if (!isObj(c)) continue;
    if (typeof c.command !== "string" || !COMMAND_RE.test(c.command)) continue;
    if (typeof c.title !== "string" || !c.title.trim()) continue;
    out.push({
      extensionId: manifest.id,
      command: c.command,
      title: c.title,
      category: typeof c.category === "string" ? c.category : undefined,
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
    console.error("[arterm] extensions_list failed:", e);
    useExtensionsStore.getState().set([], []);
    extensionHost.syncExtensions(new Map());
    useExtensionCommandsStore.getState().set([]);
    return;
  }

  const disabled = await getDisabledIds();
  const extensions: LoadedExtension[] = [];
  const enabledThemes: Theme[] = [];
  const enabledSnippets: Snippet[] = [];
  const enabledCommands: ExtensionCommand[] = [];
  /** Enabled executable extensions whose entry source must be resolved. */
  const pendingExec: Array<{
    folder: string;
    manifest: ExtensionManifest;
  }> = [];

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
      if (manifest && isExecutable(manifest)) {
        enabledCommands.push(...resolveCommands(manifest));
        pendingExec.push({ folder: r.folder, manifest });
      }
    }
  }

  // Resolve executable entry sources (inline or read from disk) in parallel,
  // pairing each with the permissions its manifest declared.
  const runtimes = new Map<string, ExtensionRuntime>();
  const startupIds: string[] = [];
  await Promise.all(
    pendingExec.map(async ({ folder, manifest }) => {
      const source = await resolveSource(folder, manifest);
      if (source == null) return;
      const permissions = new Set(
        (manifest.permissions ?? []).filter(
          (p): p is string => typeof p === "string",
        ),
      );
      runtimes.set(manifest.id, { source, permissions });
      const events = manifest.activationEvents ?? [];
      if (events.includes("onStartup") || events.includes("*")) {
        startupIds.push(manifest.id);
      }
    }),
  );

  useExtensionsStore.getState().set(extensions, enabledThemes);
  useSnippetsStore.getState().setExtensionSnippets(enabledSnippets);
  // Hand executable extensions to the host (lazy activation) and surface their
  // declared commands to the palette. Code does not run until a command fires…
  extensionHost.syncExtensions(runtimes);
  useExtensionCommandsStore.getState().set(enabledCommands);
  // …except extensions that asked to run at startup, which we activate now.
  for (const id of startupIds) {
    void extensionHost
      .ensureActivated(id)
      .catch((e) =>
        console.error(`[arterm] startup activation ${id} failed:`, e),
      );
  }
}

/** Reload this window's extension state and tell the other window to do the
 *  same. The single reload+broadcast path for every install/update/uninstall/
 *  toggle, so theme + snippet contributions propagate to both webviews. */
export async function reloadAfterInstall(): Promise<void> {
  await loadExtensions();
  await emitExtensionsChanged();
}

export async function toggleExtension(
  id: string,
  enabled: boolean,
): Promise<void> {
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

/** Install the bundled demo pack so users can see the system working at once.
 *  Writes the manifest plus its `main.js` as separate files, exercising the
 *  same file-based storage a real packaged extension uses. */
export async function installSampleExtension(): Promise<void> {
  await invoke("extensions_write", {
    id: SAMPLE_EXTENSION.id,
    manifest: JSON.stringify(SAMPLE_EXTENSION, null, 2),
    files: { "main.js": SAMPLE_MAIN_JS },
  });
  await reloadAfterInstall();
}

/** The sample extension's entry code, stored on disk as `main.js`. */
const SAMPLE_MAIN_JS = [
  "exports.activate = (context) => {",
  '  const cmd = arterm.commands.registerCommand("sample.hello", () => {',
  '    arterm.window.showInformationMessage("Hello from the Sample Extension! \\uD83C\\uDF89");',
  "  });",
  "  context.subscriptions.push(cmd);",
  '  console.log("sample-pack activated");',
  "};",
  "exports.deactivate = () => {};",
].join("\n");

/** A self-contained demo: one theme, one snippet, and one executable command
 *  that runs in the worker sandbox and calls back into the host API. */
const SAMPLE_EXTENSION: ExtensionManifest = {
  id: "arterm.sample-pack",
  name: "Sample Pack",
  version: "1.1.0",
  author: "Arterm",
  description:
    "Demo extension — a 'Midnight Ocean' theme, a /snippet, and a Hello command.",
  engines: { arterm: "^0.8.0" },
  permissions: [],
  activationEvents: ["onCommand:sample.hello"],
  main: "main.js",
  contributes: {
    commands: [
      {
        command: "sample.hello",
        title: "Hello from Sample Extension",
        category: "Sample",
      },
    ],
    themes: [
      {
        id: "midnight-ocean",
        name: "Midnight Ocean",
        author: "Arterm",
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
                "#1b2733",
                "#ff6b6b",
                "#7bdcb5",
                "#ffd166",
                "#4cc9f0",
                "#b39ddb",
                "#2a9d8f",
                "#cdd9e5",
                "#3a4a5a",
                "#ff8787",
                "#a0e8c8",
                "#ffe0a3",
                "#82dbff",
                "#d1c4e9",
                "#5fc7b8",
                "#ffffff",
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
        content:
          "Explain what the following command output means, concisely:\n",
      },
    ],
  },
};
