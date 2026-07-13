import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { createProxyFetch } from "@/modules/ai/lib/proxyFetch";
import { type CliSessionClient, createCliSessionClient } from "./client";
import { registerCliClient, unregisterCliClient } from "./clientRegistry";
import { useCliStatusStore } from "./store/cliStatusStore";
import type { CliSessionInfo } from "./types";

const proxyFetch = createProxyFetch({ allowPrivateNetwork: true });
const POLL_MS = 2000;

/** Token-less liveness probe. A stale discovery file (crashed pid, not yet
 *  swept) fails here, so we never open a doomed SSE connection. */
async function healthOk(info: CliSessionInfo): Promise<boolean> {
  try {
    const res = await proxyFetch(`http://127.0.0.1:${info.port}/api/health`, {
      method: "GET",
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { ok?: boolean; sessionId?: string };
    // Guard against a recycled port now owned by an unrelated process.
    return json.ok === true && json.sessionId === info.sessionId;
  } catch {
    return false;
  }
}

/**
 * Headless discovery + connection manager for CLI sessions. Polls the Rust
 * discovery command every {@link POLL_MS}, health-checks new sessions, and
 * opens one live client per healthy session — feeding the store. Sessions
 * whose discovery file vanishes are disconnected and dropped.
 */
export function CliStatusBridge() {
  useEffect(() => {
    let alive = true;
    const clients = new Map<string, CliSessionClient>();
    // Sessions with an in-flight health check, so a fast poll can't double-open.
    const pending = new Set<string>();
    const store = useCliStatusStore.getState();

    const openClient = (info: CliSessionInfo) => {
      const client = createCliSessionClient(info, {
        onSnapshot: (state, events) =>
          store.setSnapshot(info.sessionId, state, events),
        onState: (state) => store.setSnapshot(info.sessionId, state),
        onEvent: (ev) => store.appendEvent(info.sessionId, ev),
        onConnection: (c) => store.setConnection(info.sessionId, c),
      });
      clients.set(info.sessionId, client);
      registerCliClient(info.sessionId, client);
    };

    const dropClient = (sessionId: string, client: CliSessionClient) => {
      client.close();
      clients.delete(sessionId);
      unregisterCliClient(sessionId);
    };

    const poll = async () => {
      let list: CliSessionInfo[];
      try {
        list = await invoke<CliSessionInfo[]>("arterm_cli_list_sessions");
      } catch {
        return; // Command unavailable (older shell) — try again next tick.
      }
      if (!alive) return;

      const seen = new Set<string>();
      for (const info of list) {
        seen.add(info.sessionId);

        if (info.v !== 1) {
          store.upsertInfo(info);
          store.markUnsupported(info.sessionId);
          continue;
        }
        if (clients.has(info.sessionId)) {
          store.upsertInfo(info); // Refresh info on an already-live session.
          continue;
        }
        if (pending.has(info.sessionId)) continue;

        pending.add(info.sessionId);
        void healthOk(info).then((ok) => {
          pending.delete(info.sessionId);
          if (!alive || clients.has(info.sessionId)) return;
          if (!ok) return; // Dead/stale — re-probe on a later poll.
          store.upsertInfo(info);
          openClient(info);
        });
      }

      // Tear down sessions whose discovery file disappeared.
      for (const [sessionId, client] of clients) {
        if (!seen.has(sessionId)) {
          dropClient(sessionId, client);
          store.remove(sessionId);
        }
      }
      // Drop lingering store entries (e.g. unsupported ones) that vanished too.
      for (const sessionId of Object.keys(
        useCliStatusStore.getState().sessions,
      )) {
        if (!seen.has(sessionId) && !clients.has(sessionId)) {
          store.remove(sessionId);
        }
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), POLL_MS);

    return () => {
      alive = false;
      window.clearInterval(timer);
      for (const [sessionId, client] of clients) {
        dropClient(sessionId, client);
      }
    };
  }, []);

  return null;
}
