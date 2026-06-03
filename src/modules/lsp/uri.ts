// Canonical frontend path form is forward-slash (see ARTEX.md). LSP servers
// speak file:// URIs. Keep the Windows drive colon literal (file:///C:/...)
// since the language servers we target accept it and round-trip it verbatim.

export function pathToUri(p: string): string {
  let path = p.replace(/\\/g, "/");
  if (!path.startsWith("/")) path = `/${path}`;
  const encoded = path
    .split("/")
    .map((seg) => encodeURIComponent(seg).replace(/%3A/gi, ":"))
    .join("/");
  return `file://${encoded}`;
}

export function uriToPath(uri: string): string {
  let u = uri;
  if (u.startsWith("file://")) u = u.slice("file://".length);
  u = decodeURIComponent(u);
  if (/^\/[a-zA-Z]:/.test(u)) u = u.slice(1);
  return u;
}

// Compare two file URIs for the same on-disk target, tolerating case and
// encoding drift (Windows drive-letter casing, %3A vs ":").
export function sameUri(a: string, b: string): boolean {
  return uriToPath(a).toLowerCase() === uriToPath(b).toLowerCase();
}
