export async function appConfigDir(): Promise<string> {
  return window.artermBridge?.paths.appConfig ?? "";
}

export async function homeDir(): Promise<string> {
  return window.artermBridge?.paths.home ?? "";
}

export async function downloadDir(): Promise<string> {
  return window.artermBridge?.paths.download ?? "";
}

export async function join(...parts: string[]): Promise<string> {
  // Collapse duplicate separators while preserving a single leading slash.
  return parts.join("/").replace(/\/{2,}/g, "/");
}
