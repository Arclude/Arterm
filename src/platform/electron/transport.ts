// WebSocket bridge transport for the Electron shell. The Rust backend keeps
// running as a separate process and exposes a WebSocket endpoint that speaks
// the v1 bridge protocol; this module mirrors the Tauri `invoke`/`Channel`/
// event surfaces on top of it so the rest of the app is shell-agnostic.

const RECONNECT_MS = 500;

/** Event envelope handed to `listen` handlers, matching Tauri's `Event<T>`. */
export type BridgeEvent<T> = {
  event: string;
  id: number;
  payload: T;
};

export type BridgeEventHandler<T> = (event: BridgeEvent<T>) => void;

let nextChannelId = 0;
const channels = new Map<number, Channel<unknown>>();

/**
 * Streaming sink, surface-compatible with `@tauri-apps/api/core` `Channel`.
 * Callers do `const c = new Channel<T>(); c.onmessage = fn;` then pass `c`
 * inside invoke args; the transport serialises it to `{ __arterm_chan__: id }`
 * and routes matching server frames back into `onmessage`.
 */
export class Channel<T = unknown> {
  readonly id: number;
  onmessage: (message: T) => void = () => {};

  constructor(onmessage?: (message: T) => void) {
    this.id = nextChannelId++;
    if (onmessage) this.onmessage = onmessage;
  }
}

/**
 * Recursively replace `Channel` instances inside invoke args with their wire
 * marker, registering each one so incoming frames can be routed to it. Plain
 * objects and arrays are cloned; every other value is passed through untouched.
 */
function encodeArgs(value: unknown): unknown {
  if (value instanceof Channel) {
    channels.set(value.id, value as Channel<unknown>);
    return { __arterm_chan__: value.id };
  }
  if (Array.isArray(value)) {
    return value.map(encodeArgs);
  }
  if (value !== null && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        out[key] = encodeArgs(val);
      }
      return out;
    }
  }
  return value;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

class BridgeTransport {
  private ws: WebSocket | null = null;
  private nextInvokeId = 1;
  private nextListenerId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<
    string,
    Map<number, BridgeEventHandler<unknown>>
  >();
  private outbox: string[] = [];

  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const id = this.nextInvokeId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.send({ t: "invoke", id, cmd, args: encodeArgs(args ?? {}) });
    });
  }

  emit(event: string, payload?: unknown): Promise<void> {
    const value = payload ?? null;
    this.send({ t: "emit", event, payload: value });
    // Local loopback: Tauri delivers a window's own emits to its listeners.
    this.dispatch(event, value);
    return Promise.resolve();
  }

  listen<T>(
    event: string,
    handler: BridgeEventHandler<T>,
  ): Promise<() => void> {
    let byId = this.listeners.get(event);
    if (!byId) {
      byId = new Map();
      this.listeners.set(event, byId);
    }
    const id = this.nextListenerId++;
    byId.set(id, handler as BridgeEventHandler<unknown>);
    this.ensureConnection();
    return Promise.resolve(() => {
      const bucket = this.listeners.get(event);
      if (!bucket) return;
      bucket.delete(id);
      if (bucket.size === 0) this.listeners.delete(event);
    });
  }

  private dispatch(event: string, payload: unknown): void {
    const byId = this.listeners.get(event);
    if (!byId) return;
    for (const [id, handler] of byId) {
      handler({ event, id, payload });
    }
  }

  private send(message: unknown): void {
    this.outbox.push(JSON.stringify(message));
    this.ensureConnection();
    this.flush();
  }

  private flush(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    for (const message of this.outbox) this.ws.send(message);
    this.outbox = [];
  }

  private ensureConnection(): void {
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    const info = window.artermBridge?.bridgeInfo;
    if (!info) {
      throw new Error("artermBridge is unavailable; not running under Electron");
    }
    const ws = new WebSocket(`${info.url}/bridge?token=${info.token}`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => this.flush();
    ws.onmessage = (event) => this.handleMessage(event.data);
    ws.onclose = () => this.scheduleReconnect(ws);
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect(dead: WebSocket): void {
    if (this.ws === dead) this.ws = null;
    setTimeout(() => this.ensureConnection(), RECONNECT_MS);
  }

  private handleMessage(data: string | ArrayBuffer): void {
    if (data instanceof ArrayBuffer) {
      if (data.byteLength < 4) return;
      const chanId = new DataView(data).getUint32(0, true);
      channels.get(chanId)?.onmessage(data.slice(4));
      return;
    }
    const msg = JSON.parse(data);
    switch (msg.t) {
      case "result": {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        if (msg.ok) pending.resolve(msg.value);
        else pending.reject(msg.error);
        return;
      }
      case "chan": {
        channels.get(msg.chan)?.onmessage(msg.value);
        return;
      }
      case "event": {
        this.dispatch(msg.event, msg.payload);
        return;
      }
    }
  }
}

export const transport = new BridgeTransport();
