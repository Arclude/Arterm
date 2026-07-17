// Electron shell exposes no process metadata to the renderer; Linux is the
// only Electron target, so these are fixed.
export function platform(): string {
  return "linux";
}

export function arch(): string {
  return "x86_64";
}
