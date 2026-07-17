export function openUrl(url: string): Promise<void> {
  return window.artermBridge?.openExternal(url) ?? Promise.resolve();
}

export function openPath(path: string): Promise<void> {
  return window.artermBridge?.openPath(path) ?? Promise.resolve();
}

export function revealItemInDir(path: string): Promise<void> {
  return window.artermBridge?.revealItemInDir(path) ?? Promise.resolve();
}
