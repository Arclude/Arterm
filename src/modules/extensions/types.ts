import type { Snippet } from "@/modules/ai/lib/snippets";
import type { Theme } from "@/modules/theme/types";

/**
 * An extension package. Lives on disk as
 * `{appLocalData}/extensions/<folder>/artex-extension.json`.
 *
 * Phase 1 (declarative): only `contributes.themes` / `contributes.snippets`.
 * No code runs, so installing one carries no execution risk.
 *
 * Phase 2 (executable): when `mainSource` is present the extension is run as
 * code inside a sandboxed Web Worker (the extension host). It may then
 * `contributes.commands` and bind their handlers at activation time. The
 * worker has no DOM and no filesystem access — every capability is mediated
 * by the host over a permission-gated RPC bridge.
 */
export type ExtensionManifest = {
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  engines?: { artex?: string };
  /** Declared, human-readable capability hints (informational in Phase 1). */
  permissions?: string[];
  /**
   * Package-relative entry file for an executable extension (e.g. `"main.js"`).
   * The loader reads it from disk via `extensions_read_file` and runs it in the
   * worker sandbox. This is the preferred carrier for packaged extensions.
   */
  main?: string;
  /**
   * Inline entry-point JavaScript, as an alternative to `main`. Convenient for
   * tiny extensions shipped as a single JSON manifest (no package), and used by
   * the bundled sample. `main` takes precedence when both are present.
   *
   * The source runs with `artex`, `module`, `exports`, and `console` in scope
   * and should set `exports.activate(context)` / `exports.deactivate()`.
   */
  mainSource?: string;
  /**
   * When the extension's code should be loaded. Until one of these fires, only
   * its declarative `contributes` are registered (e.g. commands show in the
   * palette) — no code runs. Supported: `"onStartup"`, `"*"`,
   * `"onCommand:<id>"`. A contributed command implicitly activates on invoke.
   */
  activationEvents?: string[];
  contributes?: {
    themes?: Theme[];
    snippets?: ContributedSnippet[];
    commands?: ContributedCommand[];
  };
};

/** A command an extension contributes to the palette (Phase 2). The handler is
 *  bound at activation time via `artex.commands.registerCommand`. */
export type ContributedCommand = {
  /** Stable command id, e.g. "hello.world". Invoked to run the handler. */
  command: string;
  /** Label shown in the command palette. */
  title: string;
  /** Optional grouping label shown alongside the title. */
  category?: string;
};

/** A snippet as authored in a manifest — no `id` (it is derived). */
export type ContributedSnippet = {
  handle: string;
  name: string;
  description?: string;
  content: string;
};

/** Raw row returned by the Rust `extensions_list` command. */
export type RawExtension = {
  dir: string;
  folder: string;
  manifest: unknown | null;
  error: string | null;
};

/** A fully resolved + validated extension as held in the frontend registry. */
export type LoadedExtension = {
  /** On-disk folder name (stable identifier for uninstall). */
  folder: string;
  dir: string;
  /** Validated manifest, or null when the package failed to load. */
  manifest: ExtensionManifest | null;
  enabled: boolean;
  /** Load/validation error to surface in the UI; null when healthy. */
  error: string | null;
  /** Namespaced theme ids this extension contributes (for the UI summary). */
  themeIds: string[];
  /** Resolved snippet handles this extension contributes. */
  snippetHandles: string[];
};

/** Marker so contributed themes/snippets can be distinguished from user ones. */
export const EXT_THEME_PREFIX = "ext:";

export type ResolvedExtension = {
  extensions: LoadedExtension[];
  /** Themes from enabled extensions, ready to merge into the theme list. */
  enabledThemes: Theme[];
  /** Snippets from enabled extensions, ready for the snippet store. */
  enabledSnippets: Snippet[];
};
