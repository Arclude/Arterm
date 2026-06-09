import { type DapMessage, type DapResponse } from "./protocol";
import { type DapTransport, startDebugAdapter } from "./transport";

// Debug Adapter Protocol client over the Rust transport. Owns seq-based
// request/response correlation, event dispatch, and replies to the reverse
// requests an adapter sends (so it doesn't hang). DAP semantics only — session
// orchestration (initialize → launch → configurationDone) lives in session.ts.
//
// DAP wire shape differs from LSP's JSON-RPC: every message carries a monotonic
// `seq`; responses reference `request_seq`; events carry an `event` name.

type Pending = {
  resolve: (body: unknown) => void;
  reject: (reason: unknown) => void;
  command: string;
};

type EventHandler = (body: unknown) => void;
type ReverseRequestHandler = (args: unknown) => Promise<unknown> | unknown;

export type DapClientOptions = {
  command: string;
  args: string[];
  cwd: string;
};

export class DapClient {
  private transport: DapTransport | null = null;
  private seq = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly eventHandlers = new Map<string, Set<EventHandler>>();
  private readonly reverseHandlers = new Map<string, ReverseRequestHandler>();
  private disposed = false;

  static async create(opts: DapClientOptions): Promise<DapClient> {
    const client = new DapClient();
    client.transport = await startDebugAdapter({
      command: opts.command,
      args: opts.args,
      cwd: opts.cwd,
      onMessage: (raw) => client.onRaw(raw),
    });
    return client;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Send a DAP request and resolve with its response `body`. */
  request<R = unknown>(command: string, args?: unknown): Promise<R> {
    if (this.disposed || !this.transport) {
      return Promise.reject(new Error("dap client disposed"));
    }
    const seq = this.seq++;
    const message = JSON.stringify({
      seq,
      type: "request",
      command,
      arguments: args,
    });
    return new Promise<R>((resolve, reject) => {
      this.pending.set(seq, {
        resolve: resolve as (b: unknown) => void,
        reject,
        command,
      });
      void this.transport!.send(message).catch((e) => {
        this.pending.delete(seq);
        reject(e);
      });
    });
  }

  /** Subscribe to a DAP event (stopped, output, terminated, ...). */
  onEvent(event: string, handler: EventHandler): () => void {
    let set = this.eventHandlers.get(event);
    if (!set) {
      set = new Set();
      this.eventHandlers.set(event, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  /**
   * Register a reply for a reverse request the adapter may send (runInTerminal,
   * startDebugging). Unhandled reverse requests get a generic failure response
   * so the adapter doesn't block.
   */
  onReverseRequest(command: string, handler: ReverseRequestHandler): void {
    this.reverseHandlers.set(command, handler);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const [, p] of this.pending)
      p.reject(new Error("dap client disposed"));
    this.pending.clear();
    this.eventHandlers.clear();
    this.reverseHandlers.clear();
    await this.transport?.stop().catch(() => {});
    this.transport = null;
  }

  private onRaw(raw: string): void {
    let msg: DapMessage;
    try {
      msg = JSON.parse(raw) as DapMessage;
    } catch {
      return;
    }

    switch (msg.type) {
      case "response":
        this.onResponse(msg);
        return;
      case "event": {
        const set = this.eventHandlers.get(msg.event);
        if (set) for (const h of [...set]) h(msg.body);
        return;
      }
      case "request":
        void this.onReverseRequest_(msg.seq, msg.command, msg.arguments);
        return;
    }
  }

  private onResponse(msg: DapResponse): void {
    const pending = this.pending.get(msg.request_seq);
    if (!pending) return;
    this.pending.delete(msg.request_seq);
    if (msg.success) {
      pending.resolve(msg.body);
    } else {
      pending.reject(
        new Error(msg.message || `${pending.command} request failed`),
      );
    }
  }

  private async onReverseRequest_(
    requestSeq: number,
    command: string,
    args: unknown,
  ): Promise<void> {
    const handler = this.reverseHandlers.get(command);
    if (!handler) {
      this.respond(requestSeq, command, false, undefined, "unsupported");
      return;
    }
    try {
      const body = await handler(args);
      this.respond(requestSeq, command, true, body);
    } catch (e) {
      this.respond(
        requestSeq,
        command,
        false,
        undefined,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  private respond(
    requestSeq: number,
    command: string,
    success: boolean,
    body?: unknown,
    message?: string,
  ): void {
    if (!this.transport) return;
    const seq = this.seq++;
    void this.transport
      .send(
        JSON.stringify({
          seq,
          type: "response",
          request_seq: requestSeq,
          success,
          command,
          ...(body !== undefined ? { body } : {}),
          ...(message !== undefined ? { message } : {}),
        }),
      )
      .catch(() => {});
  }
}
