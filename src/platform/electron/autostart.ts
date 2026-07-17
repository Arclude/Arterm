// Launch-at-login is not managed from the renderer under Electron yet.
export async function enable(): Promise<void> {}

export async function disable(): Promise<void> {}

export async function isEnabled(): Promise<boolean> {
  return false;
}
