export async function getVersion(): Promise<string> {
  return window.artermBridge?.appInfo.version ?? "0.0.0";
}

export async function getName(): Promise<string> {
  return window.artermBridge?.appInfo.name ?? "Arterm";
}
