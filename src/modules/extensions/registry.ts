import { invoke } from "@tauri-apps/api/core";
import { parseManifest, reloadAfterInstall } from "./loader";
import { getRegistryUrl } from "./store";
import type { ExtensionManifest } from "./types";

/**
 * Default GitHub-hosted registry. Override per-user via the Marketplace UI
 * (persisted in the extensions store). Point it at any raw `index.json`.
 * Create the registry repo (e.g. Arclude/arterm-extensions) to populate it.
 */
export const DEFAULT_REGISTRY_URL =
  "https://raw.githubusercontent.com/Arclude/arterm-extensions/main/index.json";

const REGISTRY_SCHEMA_MAX = 1;

export type RegistryEntry = {
  id: string;
  name: string;
  version: string;
  manifestUrl: string;
  description?: string;
  author?: string;
  homepage?: string;
  tags?: string[];
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Fetch arbitrary https text through the SSRF-hardened, size-capped Rust command. */
export async function fetchText(url: string): Promise<string> {
  return invoke<string>("extensions_fetch_text", { url });
}

export async function getEffectiveRegistryUrl(): Promise<string> {
  return (await getRegistryUrl()) ?? DEFAULT_REGISTRY_URL;
}

/** Fetch + validate the registry index. Malformed entries are dropped, never thrown. */
export async function fetchRegistry(url?: string): Promise<RegistryEntry[]> {
  const target = url ?? (await getEffectiveRegistryUrl());
  const text = await fetchText(target);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("registry is not valid JSON");
  }
  if (!isObj(parsed) || !Array.isArray(parsed.extensions)) {
    throw new Error("registry has no 'extensions' array");
  }
  if (
    typeof parsed.schema === "number" &&
    parsed.schema > REGISTRY_SCHEMA_MAX
  ) {
    console.warn(
      `[arterm] registry schema ${parsed.schema} newer than supported`,
    );
  }
  const byId = new Map<string, RegistryEntry>();
  for (const e of parsed.extensions as unknown[]) {
    if (!isObj(e)) continue;
    const id = str(e.id);
    const name = str(e.name);
    const version = str(e.version);
    const manifestUrl = str(e.manifestUrl);
    if (!id || !name || version === undefined) continue;
    if (!manifestUrl || !manifestUrl.startsWith("https://")) continue;
    byId.set(id, {
      id,
      name,
      version,
      manifestUrl,
      description: str(e.description),
      author: str(e.author),
      homepage: str(e.homepage),
      tags: Array.isArray(e.tags)
        ? e.tags.filter((t): t is string => typeof t === "string")
        : undefined,
    });
  }
  return [...byId.values()];
}

export function validateManifestText(text: string): ExtensionManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("not valid JSON");
  }
  return parseManifest(parsed); // throws a friendly message on a bad manifest
}

/** Core install path shared by registry / URL / file. Validates, writes under
 *  the manifest id (same id overwrites = update), then reloads + broadcasts. */
export async function installFromManifestText(
  text: string,
): Promise<ExtensionManifest> {
  const manifest = validateManifestText(text);
  await invoke("extensions_write", { id: manifest.id, manifest: text });
  await reloadAfterInstall();
  return manifest;
}

export async function installFromRegistry(
  entry: RegistryEntry,
): Promise<ExtensionManifest> {
  if (!entry.manifestUrl.startsWith("https://")) {
    throw new Error("manifestUrl must be https");
  }
  return installFromManifestText(await fetchText(entry.manifestUrl));
}

/** Accepts a raw https manifest URL, a github.com blob URL, or "owner/repo". */
function normalizeInstallUrl(input: string): string {
  const s = input.trim();
  if (/^https:\/\//i.test(s)) {
    const blob = s.match(
      /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/i,
    );
    if (blob) {
      return `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}`;
    }
    return s;
  }
  const repo = s.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (repo) {
    return `https://raw.githubusercontent.com/${repo[1]}/${repo[2]}/main/arterm-extension.json`;
  }
  throw new Error("enter an https raw manifest URL or owner/repo");
}

export async function installFromUrl(
  input: string,
): Promise<ExtensionManifest> {
  return installFromManifestText(await fetchText(normalizeInstallUrl(input)));
}

export async function installFromFile(file: File): Promise<ExtensionManifest> {
  return installFromManifestText(await file.text());
}
