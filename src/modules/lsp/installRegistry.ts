import { arch, platform } from "@tauri-apps/plugin-os";

// Registry of one-click-installable language servers, keyed by the same
// serverId used in DEFAULT_LSP_SERVERS. Phase 1 covers binary servers only
// (no Node runtime needed); npm-based servers come later.

export type ArchiveKind = "gz" | "zip" | "none";

export type PlatformAsset = {
  url: string;
  archive: ArchiveKind;
  /** Final on-disk binary name (with extension on Windows). */
  binName: string;
};

export type InstallEntry = {
  /** Must match a DEFAULT_LSP_SERVERS / serverId key. */
  id: string;
  label: string;
  /** Human label for the pinned version; "latest" tracks the newest release. */
  version: string;
  homepage: string;
  /** Keyed by platformKey(); a missing key means "unsupported on this platform". */
  assets: Record<string, PlatformAsset>;
};

// rust-analyzer ships a gzipped standalone binary per target on every GitHub
// release. The /releases/latest/download/ redirect always resolves to the
// newest release's asset, so we never hardcode a release tag that goes stale.
const RA_BASE =
  "https://github.com/rust-lang/rust-analyzer/releases/latest/download";

const rustAnalyzer: InstallEntry = {
  id: "rust",
  label: "Rust (rust-analyzer)",
  version: "latest",
  homepage: "https://github.com/rust-lang/rust-analyzer",
  assets: {
    "win-x64": {
      url: `${RA_BASE}/rust-analyzer-x86_64-pc-windows-msvc.zip`,
      archive: "zip",
      binName: "rust-analyzer.exe",
    },
    "win-arm64": {
      url: `${RA_BASE}/rust-analyzer-aarch64-pc-windows-msvc.zip`,
      archive: "zip",
      binName: "rust-analyzer.exe",
    },
    "mac-arm64": {
      url: `${RA_BASE}/rust-analyzer-aarch64-apple-darwin.gz`,
      archive: "gz",
      binName: "rust-analyzer",
    },
    "mac-x64": {
      url: `${RA_BASE}/rust-analyzer-x86_64-apple-darwin.gz`,
      archive: "gz",
      binName: "rust-analyzer",
    },
    "linux-x64": {
      url: `${RA_BASE}/rust-analyzer-x86_64-unknown-linux-gnu.gz`,
      archive: "gz",
      binName: "rust-analyzer",
    },
    "linux-arm64": {
      url: `${RA_BASE}/rust-analyzer-aarch64-unknown-linux-gnu.gz`,
      archive: "gz",
      binName: "rust-analyzer",
    },
  },
};

export const INSTALL_REGISTRY: Record<string, InstallEntry> = {
  rust: rustAnalyzer,
};

/** Combine os + arch into a registry asset key, or null if unsupported. */
export function platformKey(): string | null {
  const osKey =
    platform() === "windows"
      ? "win"
      : platform() === "macos"
        ? "mac"
        : platform() === "linux"
          ? "linux"
          : null;
  const archKey =
    arch() === "x86_64" ? "x64" : arch() === "aarch64" ? "arm64" : null;
  if (!osKey || !archKey) return null;
  return `${osKey}-${archKey}`;
}

/** The downloadable asset for this platform, or null if none is published. */
export function assetFor(entry: InstallEntry): PlatformAsset | null {
  const key = platformKey();
  if (!key) return null;
  return entry.assets[key] ?? null;
}
