// User-tunable language-server config. Persisted in preferences under
// `lspServers`, keyed by server id. Merged over DEFAULT_LSP_SERVERS at runtime.
export type LspServerConfig = {
  command: string;
  args: string[];
  enabled?: boolean;
};

export type LspServerDefault = {
  label: string;
  command: string;
  args: string[];
};

// Server id -> default invocation. The command is resolved on PATH at spawn
// time; on Windows the Rust side walks PATH+PATHEXT so npm `.cmd` shims
// (typescript-language-server, pyright-langserver, ...) are found.
export const DEFAULT_LSP_SERVERS: Record<string, LspServerDefault> = {
  typescript: {
    label: "TypeScript / JavaScript",
    command: "typescript-language-server",
    args: ["--stdio"],
  },
  python: {
    label: "Python (Pyright)",
    command: "pyright-langserver",
    args: ["--stdio"],
  },
  rust: { label: "Rust (rust-analyzer)", command: "rust-analyzer", args: [] },
  go: { label: "Go (gopls)", command: "gopls", args: [] },
  c: { label: "C (clangd)", command: "clangd", args: [] },
  cpp: { label: "C++ (clangd)", command: "clangd", args: [] },
  css: {
    label: "CSS / SCSS / Less",
    command: "vscode-css-language-server",
    args: ["--stdio"],
  },
  html: {
    label: "HTML",
    command: "vscode-html-language-server",
    args: ["--stdio"],
  },
  json: {
    label: "JSON",
    command: "vscode-json-language-server",
    args: ["--stdio"],
  },
  bash: { label: "Bash", command: "bash-language-server", args: ["start"] },
};

export type LanguageInfo = {
  // The textDocument languageId sent in didOpen.
  languageId: string;
  // The DEFAULT_LSP_SERVERS / preferences key used to pick a server.
  serverId: string;
};

const EXT_LANGUAGE: Record<string, LanguageInfo> = {
  ts: { languageId: "typescript", serverId: "typescript" },
  mts: { languageId: "typescript", serverId: "typescript" },
  cts: { languageId: "typescript", serverId: "typescript" },
  tsx: { languageId: "typescriptreact", serverId: "typescript" },
  js: { languageId: "javascript", serverId: "typescript" },
  mjs: { languageId: "javascript", serverId: "typescript" },
  cjs: { languageId: "javascript", serverId: "typescript" },
  jsx: { languageId: "javascriptreact", serverId: "typescript" },
  py: { languageId: "python", serverId: "python" },
  pyi: { languageId: "python", serverId: "python" },
  rs: { languageId: "rust", serverId: "rust" },
  go: { languageId: "go", serverId: "go" },
  c: { languageId: "c", serverId: "c" },
  h: { languageId: "c", serverId: "c" },
  cpp: { languageId: "cpp", serverId: "cpp" },
  cc: { languageId: "cpp", serverId: "cpp" },
  cxx: { languageId: "cpp", serverId: "cpp" },
  hpp: { languageId: "cpp", serverId: "cpp" },
  hh: { languageId: "cpp", serverId: "cpp" },
  css: { languageId: "css", serverId: "css" },
  scss: { languageId: "scss", serverId: "css" },
  less: { languageId: "less", serverId: "css" },
  html: { languageId: "html", serverId: "html" },
  htm: { languageId: "html", serverId: "html" },
  json: { languageId: "json", serverId: "json" },
  jsonc: { languageId: "jsonc", serverId: "json" },
  sh: { languageId: "shellscript", serverId: "bash" },
  bash: { languageId: "shellscript", serverId: "bash" },
};

export function languageInfoForPath(path: string): LanguageInfo | null {
  const ext = path.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase();
  if (!ext) return null;
  return EXT_LANGUAGE[ext] ?? null;
}

// Effective config for a server id: user override merged over the default,
// `enabled` defaulting to true. Returns null when there is no server for the id.
export function resolveServerConfig(
  serverId: string,
  userServers: Record<string, LspServerConfig>,
): LspServerConfig | null {
  const def = DEFAULT_LSP_SERVERS[serverId];
  const override = userServers[serverId];
  if (!def && !override) return null;
  const command = override?.command?.trim() || def?.command || "";
  if (!command) return null;
  const args = override?.args ?? def?.args ?? [];
  const enabled = override?.enabled ?? true;
  return { command, args, enabled };
}
