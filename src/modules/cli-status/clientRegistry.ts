import type { CliSessionClient } from "./client";

// Lifecycle of these clients is owned by CliStatusBridge; this registry is just
// a lookup so the panel UI can reach a session's `control()` without threading
// the client through the store (which stays pure data).
const registry = new Map<string, CliSessionClient>();

export function registerCliClient(
  sessionId: string,
  client: CliSessionClient,
): void {
  registry.set(sessionId, client);
}

export function unregisterCliClient(sessionId: string): void {
  registry.delete(sessionId);
}

export function getCliClient(sessionId: string): CliSessionClient | undefined {
  return registry.get(sessionId);
}
