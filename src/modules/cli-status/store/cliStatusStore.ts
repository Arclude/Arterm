import { create } from "zustand";
import type { ConnectionState } from "../client";
import type { CliSessionInfo, StampedEvent, StatusSnapshot } from "../types";

/** Newest events kept per session for the activity feed. */
const FEED_CAP = 200;

export type CliSessionEntry = {
  info: CliSessionInfo;
  snapshot?: StatusSnapshot;
  connection: ConnectionState;
  /** Protocol version mismatch (`v !== 1`) — render an "update CLI" notice. */
  unsupported?: boolean;
  /** Rolling activity feed, capped at {@link FEED_CAP} (oldest dropped). */
  feed: StampedEvent[];
};

type CliStatusState = {
  sessions: Record<string, CliSessionEntry>;
  /** The session focused in the main dashboard. Shared so the sidebar panel and
   *  the dashboard's own navigator drive one selection. */
  selectedSessionId: string | null;
  /** Focus a session in the dashboard (or clear focus with null). */
  selectSession: (sessionId: string | null) => void;
  /** Insert or refresh the discovery info for a session (keyed by sessionId). */
  upsertInfo: (info: CliSessionInfo) => void;
  /** Replace a session's snapshot; when `feed` is given, reseed the feed. */
  setSnapshot: (
    sessionId: string,
    snapshot: StatusSnapshot,
    feed?: StampedEvent[],
  ) => void;
  setConnection: (sessionId: string, connection: ConnectionState) => void;
  appendEvent: (sessionId: string, ev: StampedEvent) => void;
  markUnsupported: (sessionId: string) => void;
  remove: (sessionId: string) => void;
};

export const useCliStatusStore = create<CliStatusState>((set) => ({
  sessions: {},
  selectedSessionId: null,

  selectSession: (sessionId) => set({ selectedSessionId: sessionId }),

  upsertInfo: (info) =>
    set((s) => {
      const existing = s.sessions[info.sessionId];
      return {
        sessions: {
          ...s.sessions,
          [info.sessionId]: existing
            ? { ...existing, info }
            : { info, connection: "connecting", feed: [] },
        },
      };
    }),

  setSnapshot: (sessionId, snapshot, feed) =>
    set((s) => {
      const existing = s.sessions[sessionId];
      if (!existing) return s;
      return {
        sessions: {
          ...s.sessions,
          [sessionId]: {
            ...existing,
            snapshot,
            feed: feed ? feed.slice(-FEED_CAP) : existing.feed,
          },
        },
      };
    }),

  setConnection: (sessionId, connection) =>
    set((s) => {
      const existing = s.sessions[sessionId];
      if (!existing || existing.connection === connection) return s;
      return {
        sessions: {
          ...s.sessions,
          [sessionId]: { ...existing, connection },
        },
      };
    }),

  appendEvent: (sessionId, ev) =>
    set((s) => {
      const existing = s.sessions[sessionId];
      if (!existing) return s;
      const feed = [...existing.feed, ev];
      if (feed.length > FEED_CAP) feed.splice(0, feed.length - FEED_CAP);
      return {
        sessions: {
          ...s.sessions,
          [sessionId]: { ...existing, feed },
        },
      };
    }),

  markUnsupported: (sessionId) =>
    set((s) => {
      const existing = s.sessions[sessionId];
      if (!existing || existing.unsupported) return s;
      return {
        sessions: {
          ...s.sessions,
          [sessionId]: { ...existing, unsupported: true },
        },
      };
    }),

  remove: (sessionId) =>
    set((s) => {
      if (!s.sessions[sessionId]) return s;
      const next = { ...s.sessions };
      delete next[sessionId];
      return {
        sessions: next,
        // Drop a dangling focus so the dashboard falls back cleanly.
        selectedSessionId:
          s.selectedSessionId === sessionId ? null : s.selectedSessionId,
      };
    }),
}));

/**
 * Rail badge count: total active agents across every live-connected session.
 * A "live" gate keeps stale/lost sessions from inflating the number.
 */
export const selectTotalActiveAgents = (s: CliStatusState): number => {
  let total = 0;
  for (const entry of Object.values(s.sessions)) {
    if (entry.connection === "live" && entry.snapshot) {
      total += entry.snapshot.activeAgents;
    }
  }
  return total;
};

/**
 * Rail presence: how many sessions are still reachable (anything but a dropped
 * connection). Drives the static "sessions online" dot on the CLI Agents button.
 */
export const selectOnlineSessionCount = (s: CliStatusState): number => {
  let n = 0;
  for (const entry of Object.values(s.sessions)) {
    if (entry.connection !== "lost") n += 1;
  }
  return n;
};

/**
 * Rail activity: true when any live session is actively working (mid-turn, in a
 * tool, running an autonomy goal, or with active sub-agents). Drives the pulsing
 * dot on the CLI Agents button.
 */
export const selectCliBusy = (s: CliStatusState): boolean => {
  for (const entry of Object.values(s.sessions)) {
    if (entry.connection !== "live" || !entry.snapshot) continue;
    const snap = entry.snapshot;
    if (
      snap.status === "thinking" ||
      snap.status === "tool" ||
      snap.autonomy.state === "running" ||
      snap.activeAgents > 0
    ) {
      return true;
    }
  }
  return false;
};
