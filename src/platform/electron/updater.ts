// No auto-updater under the Electron shell; the UI falls back to the manual
// GitHub release flow when `check` yields nothing.
export async function check(): Promise<null> {
  return null;
}
