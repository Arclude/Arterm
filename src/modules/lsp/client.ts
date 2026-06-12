import type {
  InitializeResult,
  ServerCapabilities,
} from "vscode-languageserver-protocol";
import { type LspTransport, startLspServer } from "./transport";

// JSON-RPC 2.0 client over the Rust transport. Owns the initialize handshake,
// request/response correlation, document open/change/close sync, and the
// minimal server->client request replies servers need to not hang.

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

type NotificationHandler = (params: unknown) => void;

export type LspClientOptions = {
  serverId: string;
  command: string;
  args: string[];
  rootPath: string;
  rootUri: string;
};

const CLIENT_CAPABILITIES = {
  textDocument: {
    synchronization: { didSave: true, dynamicRegistration: false },
    completion: {
      dynamicRegistration: false,
      completionItem: {
        snippetSupport: false,
        documentationFormat: ["plaintext", "markdown"],
      },
      contextSupport: true,
    },
    hover: {
      dynamicRegistration: false,
      contentFormat: ["plaintext", "markdown"],
    },
    definition: { dynamicRegistration: false, linkSupport: true },
    publishDiagnostics: { relatedInformation: true },
  },
  workspace: {
    configuration: true,
    workspaceFolders: true,
    didChangeConfiguration: { dynamicRegistration: false },
  },
};

export class LspClient {
  readonly languageId: string;
  readonly rootUri: string;
  private readonly rootPath: string;
  private transport: LspTransport | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Map<string, Set<NotificationHandler>>();
  private readonly versions = new Map<string, number>();
  private caps: ServerCapabilities | undefined;
  private disposed = false;
  private ready: Promise<void>;
  private markReady!: () => void;

  private constructor(opts: LspClientOptions) {
    this.languageId = opts.serverId;
    this.rootUri = opts.rootUri;
    this.rootPath = opts.rootPath;
    this.ready = new Promise((resolve) => {
      this.markReady = resolve;
    });
  }

  static async create(opts: LspClientOptions): Promise<LspClient> {
    const client = new LspClient(opts);
    client.transport = await startLspServer({
      languageId: opts.serverId,
      command: opts.command,
      args: opts.args,
      cwd: opts.rootPath,
      onMessage: (raw) => client.onRaw(raw),
    });
    await client.initialize();
    return client;
  }

  get capabilities(): ServerCapabilities | undefined {
    return this.caps;
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  request<R = unknown>(method: string, params?: unknown): Promise<R> {
    if (this.disposed || !this.transport) {
      return Promise.reject(new Error("lsp client disposed"));
    }
    const id = this.nextId++;
    const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      void this.transport!.send(message).catch((e) => {
        this.pending.delete(id);
        reject(e);
      });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.disposed || !this.transport) return;
    const message = JSON.stringify({ jsonrpc: "2.0", method, params });
    void this.transport.send(message).catch(() => {});
  }

  onNotification(method: string, handler: NotificationHandler): () => void {
    let set = this.handlers.get(method);
    if (!set) {
      set = new Set();
      this.handlers.set(method, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  didOpen(uri: string, languageId: string, text: string): void {
    this.versions.set(uri, 1);
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    });
  }

  didChange(uri: string, text: string): void {
    const version = (this.versions.get(uri) ?? 1) + 1;
    this.versions.set(uri, version);
    // A change event without a `range` is a full-document replace, which is
    // valid regardless of the server's advertised sync kind.
    this.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  didSave(uri: string, text?: string): void {
    this.notify("textDocument/didSave", {
      textDocument: { uri },
      ...(text !== undefined ? { text } : {}),
    });
  }

  didClose(uri: string): void {
    this.versions.delete(uri);
    this.notify("textDocument/didClose", { textDocument: { uri } });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await this.request("shutdown");
      this.notify("exit");
    } catch {
      // Server may already be gone; fall through to transport stop.
    }
    for (const [, p] of this.pending)
      p.reject(new Error("lsp client disposed"));
    this.pending.clear();
    this.handlers.clear();
    await this.transport?.stop().catch(() => {});
    this.transport = null;
  }

  private async initialize(): Promise<void> {
    const name = this.rootPath.split(/[\\/]/).pop() || "workspace";
    const result = await this.request<InitializeResult>("initialize", {
      processId: null,
      clientInfo: { name: "Arterm" },
      rootUri: this.rootUri,
      rootPath: this.rootPath,
      workspaceFolders: [{ uri: this.rootUri, name }],
      capabilities: CLIENT_CAPABILITIES,
    });
    this.caps = result.capabilities;
    this.notify("initialized", {});
    this.markReady();
  }

  private onRaw(raw: string): void {
    let msg: {
      id?: number | string;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code: number; message: string };
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.method !== undefined && msg.id !== undefined) {
      this.onServerRequest(msg.id, msg.method, msg.params);
      return;
    }
    if (msg.method !== undefined) {
      const set = this.handlers.get(msg.method);
      if (set) for (const h of [...set]) h(msg.params);
      return;
    }
    if (msg.id !== undefined && typeof msg.id === "number") {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message));
      else pending.resolve(msg.result);
    }
  }

  private onServerRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): void {
    // Reply to the handful of server->client requests that block startup if
    // ignored. Everything else gets a method-not-found error so the server
    // doesn't wait forever.
    switch (method) {
      case "workspace/configuration": {
        const items = (params as { items?: unknown[] })?.items ?? [];
        this.respond(
          id,
          items.map(() => null),
        );
        return;
      }
      case "workspace/workspaceFolders": {
        const name = this.rootPath.split(/[\\/]/).pop() || "workspace";
        this.respond(id, [{ uri: this.rootUri, name }]);
        return;
      }
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "window/workDoneProgress/create":
        this.respond(id, null);
        return;
      default:
        this.respondError(id, -32601, `method not found: ${method}`);
    }
  }

  private respond(id: number | string, result: unknown): void {
    if (!this.transport) return;
    void this.transport
      .send(JSON.stringify({ jsonrpc: "2.0", id, result }))
      .catch(() => {});
  }

  private respondError(
    id: number | string,
    code: number,
    message: string,
  ): void {
    if (!this.transport) return;
    void this.transport
      .send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }))
      .catch(() => {});
  }
}
