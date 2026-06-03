import type { Snippet } from "@/modules/ai/lib/snippets";
import type { Theme } from "@/modules/theme/types";

/**
 * A declarative extension package (Phase 1). Lives on disk as
 * `{appLocalData}/extensions/<folder>/artex-extension.json`. No code runs —
 * only declarative contributions (themes, snippets) are supported, so installing
 * one from a marketplace carries no execution risk.
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
  contributes?: {
    themes?: Theme[];
    snippets?: ContributedSnippet[];
  };
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
