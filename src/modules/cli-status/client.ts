import { createProxyFetch } from "@/modules/ai/lib/proxyFetch";
import type {
  CliSessionInfo,
  ControlAction,
  ControlResult,
  StampedEvent,
  StatusSnapshot,
} from "./types";

// The status server is loopback-only, so the fetch must be allowed to reach a
// private address. We deliberately do NOT wrap this in `sseSanitizingFetch`:
// that helper's null-stripper only drops literal `data: null` lines and would
// not mangle our custom `event:` names, but we parse the raw byte stream
// ourselves here, so bypassing it keeps the framing pristine.
const proxyFetch = createProxyFetch({ allowPrivateNetwork: true });

export type ConnectionState = "connecting" | "live" | "lost";

export type CliSessionHandlers = {
  /** Full-state frame on (re)connect: authoritative snapshot + backlog events. */
  onSnapshot: (state: StatusSnapshot, events: StampedEvent[]) => void;
  /** Throttled state-only frame. */
  onState: (state: StatusSnapshot) => void;
  /** One live bus event. */
  onEvent: (ev: StampedEvent) => void;
  onConnection: (state: ConnectionState) => void;
};

export type CliSessionClient = {
  control: (
    action: ControlAction,
    note?: string,
    mode?: string,
  ) => Promise<ControlResult>;
  close: () => void;
};

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 10_000;

/**
 * Open a live connection to one CLI session's status server: an SSE stream for
 * state/events plus a `control()` for POST actions. Reconnects with capped
 * exponential backoff, resuming from the last-seen `seq` via `?since=`.
 */
export function createCliSessionClient(
  info: CliSessionInfo,
  handlers: CliSessionHandlers,
): CliSessionClient {
  const base = `http://127.0.0.1:${info.port}`;
  const authHeader = `Bearer ${info.token}`;
  let closed = false;
  let lastSeq = 0;
  let backoff = BASE_BACKOFF_MS;
  let abort: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const noteSeq = (seq: unknown) => {
    if (typeof seq === "number" && Number.isFinite(seq) && seq > lastSeq) {
      lastSeq = seq;
    }
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer !== null) return;
    handlers.onConnection("lost");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  };

  const dispatch = (event: string, data: string, id: string | null) => {
    if (id !== null) noteSeq(Number(id));
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return; // Non-JSON frame (should not happen) — ignore.
    }
    if (event === "snapshot") {
      const payload = parsed as {
        state?: StatusSnapshot;
        events?: StampedEvent[];
      };
      if (!payload.state) return;
      const events = payload.events ?? [];
      noteSeq(payload.state.seq);
      for (const ev of events) noteSeq(ev.seq);
      handlers.onSnapshot(payload.state, events);
    } else if (event === "state") {
      handlers.onState(parsed as StatusSnapshot);
    } else if (event === "agent") {
      const ev = parsed as StampedEvent;
      noteSeq(ev.seq);
      handlers.onEvent(ev);
    }
  };

  // Parse one SSE frame (fields separated by single newlines). Comment lines
  // (leading `:`, e.g. the `: ping` keep-alive) and blank lines are ignored.
  const handleFrame = (frame: string) => {
    let event = "message";
    let id: string | null = null;
    const dataLines: string[] = [];
    for (const line of frame.split(/\r\n|\n/)) {
      if (line === "" || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") dataLines.push(value);
      else if (field === "id") id = value;
    }
    if (dataLines.length > 0) dispatch(event, dataLines.join("\n"), id);
  };

  const pump = async (body: ReadableStream<Uint8Array>) => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Frames are delimited by a blank line — handle LF and CRLF alike.
        const frames = buffer.split(/\r\n\r\n|\n\n/);
        buffer = frames.pop() ?? "";
        for (const frame of frames) handleFrame(frame);
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* stream already torn down */
      }
    }
  };

  async function connect(): Promise<void> {
    if (closed) return;
    handlers.onConnection("connecting");
    abort = new AbortController();
    const url =
      lastSeq > 0
        ? `${base}/api/stream?since=${lastSeq}`
        : `${base}/api/stream`;
    try {
      const res = await proxyFetch(url, {
        headers: { Authorization: authHeader, Accept: "text/event-stream" },
        signal: abort.signal,
      });
      if (!res.ok || !res.body) {
        scheduleReconnect();
        return;
      }
      handlers.onConnection("live");
      backoff = BASE_BACKOFF_MS; // A clean connection resets the backoff.
      await pump(res.body);
      if (!closed) scheduleReconnect(); // Server closed the stream — retry.
    } catch (err) {
      if (
        closed ||
        (err instanceof DOMException && err.name === "AbortError")
      ) {
        return;
      }
      scheduleReconnect();
    }
  }

  const control = async (
    action: ControlAction,
    note?: string,
    mode?: string,
  ): Promise<ControlResult> => {
    const body: Record<string, unknown> = { action };
    if (note !== undefined) body.note = note;
    if (mode !== undefined) body.mode = mode;
    try {
      const res = await proxyFetch(`${base}/api/control`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status}` };
      }
      const json = (await res.json()) as ControlResult;
      // The control response carries the authoritative post-action state; fold
      // it in immediately so the UI reflects the change without waiting for SSE.
      if (json.state) handlers.onState(json.state);
      return json;
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  const close = () => {
    closed = true;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    abort?.abort();
  };

  void connect();
  return { control, close };
}
