/**
 * Human-readable language name for the status bar, derived from a file's
 * extension (or a few well-known filenames). Mirrors the extensions handled by
 * languageResolver; unknown extensions fall back to their uppercased form, and
 * extension-less files report "Plain Text".
 */
const BY_EXT: Record<string, string> = {
  js: "JavaScript",
  jsx: "JavaScript JSX",
  mjs: "JavaScript",
  cjs: "JavaScript",
  ts: "TypeScript",
  tsx: "TypeScript JSX",
  rs: "Rust",
  go: "Go",
  py: "Python",
  json: "JSON",
  jsonc: "JSON with Comments",
  json5: "JSON5",
  sql: "SQL",
  psql: "PostgreSQL",
  pgsql: "PostgreSQL",
  mysql: "MySQL",
  sqlite: "SQLite",
  mariadb: "MariaDB",
  mssql: "SQL Server",
  plsql: "PL/SQL",
  md: "Markdown",
  markdown: "Markdown",
  html: "HTML",
  htm: "HTML",
  astro: "Astro",
  css: "CSS",
  php: "PHP",
  rb: "Ruby",
  rake: "Ruby",
  gemspec: "Ruby",
  ru: "Ruby",
  c: "C",
  h: "C",
  cpp: "C++",
  cc: "C++",
  cxx: "C++",
  hpp: "C++",
  hxx: "C++",
  java: "Java",
  cs: "C#",
  dart: "Dart",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  toml: "TOML",
  yaml: "YAML",
  yml: "YAML",
  dockerfile: "Dockerfile",
  tex: "LaTeX",
  latex: "LaTeX",
  sty: "LaTeX",
  cls: "LaTeX",
  "arterm-theme": "Arterm Theme",
};

const BY_NAME: Record<string, string> = {
  dockerfile: "Dockerfile",
  gemfile: "Ruby",
  rakefile: "Ruby",
  podfile: "Ruby",
  fastfile: "Ruby",
  guardfile: "Ruby",
  brewfile: "Ruby",
};

export function languageLabel(path: string): string {
  const base = (path.split(/[\\/]/).pop() ?? path).toLowerCase();
  if (BY_NAME[base]) return BY_NAME[base];
  const dot = base.lastIndexOf(".");
  if (dot === -1 || dot === base.length - 1) return "Plain Text";
  const ext = base.slice(dot + 1);
  return BY_EXT[ext] ?? ext.toUpperCase();
}
