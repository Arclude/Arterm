import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { currentWorkspaceEnv } from "@/modules/workspace";
import type { HostToWorker, WorkerToHost } from "./protocol";

/** Result shape of the Rust `fs_read_file` command. */
type ReadResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

/** A loaded executable extension: its entry source plus the permissions it
 *  declared in its manifest (used to gate sensitive host APIs). */
export type ExtensionRuntime = {
  source: string;
  permissions: Set<string>;
};

/** Host API methods that require a declared permission. Methods absent from
 *  this map are always allowed (e.g. showing a message). */
const PERMISSION_BY_METHOD: Record<string, string> = {
  "workspace.fs.readTextFile": "fs:read",
  "workspace.fs.writeTextFile": "fs:write",
};

/**
 * Main-thread side of the extension host. Owns the Web Worker, lazily activates
 * extensions, routes command invocations, and fulfils (or denies) the API calls
 * extension code makes. This is the single place where extension capabilities
 * are granted, so permission enforcement lives here.
 *
 * Activation is lazy: registering an extension only records its source. The
 * worker is spun up and the code is run the first time one of its commands is
 * invoked (or, later, when another activation event fires).
 */
class ExtensionHost {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;

  /** extensionId → runtime (source + granted permissions). Code not yet run. */
  private runtimes = new Map<string, ExtensionRuntime>();
  private activated = new Set<string>();
  private activating = new Map<string, Promise<void>>();
  private activationWaiters = new Map<
    string,
    { resolve: () => void; reject: (e: unknown) => void }
  >();

  private callSeq = 1;
  private pendingCommands = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();

  /** Replace the known executable extensions. Tears down the worker so any
   *  previously-activated (now removed/disabled) extension stops running. */
  syncExtensions(runtimes: Map<string, ExtensionRuntime>): void {
    this.runtimes = new Map(runtimes);
    this.reset();
  }

  /** Terminate the worker and forget all runtime state. The next activation
   *  recreates it. */
  reset(): void {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    this.activated.clear();
    this.activating.clear();
    for (const w of this.activationWaiters.values())
      w.reject(new Error("extension host reset"));
    this.activationWaiters.clear();
    for (const p of this.pendingCommands.values())
      p.reject(new Error("extension host reset"));
    this.pendingCommands.clear();
  }

  private ensureWorker(): Promise<void> {
    if (this.ready) return this.ready;
    const ready = new Promise<void>((resolve, reject) => {
      // True once the worker posts `ready`; after that, runtime errors are
      // logged but must not reject the (already-resolved) startup promise.
      let started = false;
      let worker: Worker;
      try {
        worker = new Worker(
          new URL("./extensionHost.worker.ts", import.meta.url),
          { type: "module" },
        );
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      worker.onmessage = (e: MessageEvent<WorkerToHost>) => {
        if (e.data.kind === "ready") started = true;
        this.handleMessage(e.data, resolve);
      };
      // Without this, a worker that fails to load would leave every
      // `ensureActivated` awaiting forever — the command silently does nothing.
      worker.onerror = (e) => {
        const detail =
          (e as ErrorEvent).message || "extension worker failed to start";
        console.error("[artex][ext-host] worker error:", detail);
        if (!started) reject(new Error(detail));
      };
      this.worker = worker;
    });
    // If startup failed, drop the cached worker so a later activation retries
    // instead of re-awaiting the same rejected promise.
    ready.catch(() => {
      if (this.ready === ready) {
        this.worker?.terminate();
        this.worker = null;
        this.ready = null;
      }
    });
    this.ready = ready;
    return ready;
  }

  private post(msg: HostToWorker): void {
    this.worker?.postMessage(msg);
  }

  /** Run an extension's code if it has not run yet. */
  async ensureActivated(extensionId: string): Promise<void> {
    if (this.activated.has(extensionId)) return;
    const inflight = this.activating.get(extensionId);
    if (inflight) return inflight;

    const runtime = this.runtimes.get(extensionId);
    if (runtime == null)
      throw new Error(`unknown or non-executable extension: ${extensionId}`);

    await this.ensureWorker();
    const p = new Promise<void>((resolve, reject) => {
      this.activationWaiters.set(extensionId, { resolve, reject });
    });
    this.activating.set(extensionId, p);
    this.post({ kind: "activate", extensionId, source: runtime.source });
    try {
      await p;
    } finally {
      this.activating.delete(extensionId);
    }
  }

  /** Invoke a contributed command, activating its extension on first use. */
  async executeCommand(
    extensionId: string,
    command: string,
    ...args: unknown[]
  ): Promise<unknown> {
    await this.ensureActivated(extensionId);
    const callId = this.callSeq++;
    return new Promise((resolve, reject) => {
      this.pendingCommands.set(callId, { resolve, reject });
      this.post({ kind: "invokeCommand", callId, extensionId, command, args });
    });
  }

  private handleMessage(msg: WorkerToHost, onReady: () => void): void {
    switch (msg.kind) {
      case "ready":
        onReady();
        break;
      case "activated": {
        const waiter = this.activationWaiters.get(msg.extensionId);
        this.activationWaiters.delete(msg.extensionId);
        if (msg.error) {
          console.error(
            `[artex][ext-host] ${msg.extensionId} activate failed:`,
            msg.error,
          );
          waiter?.reject(new Error(msg.error));
        } else {
          this.activated.add(msg.extensionId);
          waiter?.resolve();
        }
        break;
      }
      case "registeredCommand":
        // The declarative manifest already surfaces commands to the palette;
        // this confirms the handler bound. Nothing more needed for now.
        break;
      case "commandResult": {
        const pending = this.pendingCommands.get(msg.callId);
        if (!pending) break;
        this.pendingCommands.delete(msg.callId);
        if (msg.ok) pending.resolve(msg.value);
        else pending.reject(new Error(msg.error ?? "command failed"));
        break;
      }
      case "apiCall":
        void this.handleApiCall(msg);
        break;
      case "log": {
        const tag = `[ext:${msg.extensionId}]`;
        if (msg.level === "error") console.error(tag, msg.message);
        else if (msg.level === "warn") console.warn(tag, msg.message);
        else console.log(tag, msg.message);
        break;
      }
    }
  }

  /** Fulfil one host-mediated API call from an extension. This is the
   *  capability gate: unknown methods are rejected, and methods requiring a
   *  permission the extension did not declare are denied. */
  private async handleApiCall(msg: {
    callId: number;
    extensionId: string;
    method: string;
    args: unknown[];
  }): Promise<void> {
    try {
      const required = PERMISSION_BY_METHOD[msg.method];
      if (required) {
        const granted = this.runtimes.get(msg.extensionId)?.permissions;
        if (!granted?.has(required)) {
          throw new Error(
            `permission denied: "${msg.method}" requires "${required}" — declare it in the manifest "permissions"`,
          );
        }
      }
      const value = await this.dispatchApi(msg.method, msg.args);
      this.post({ kind: "apiResult", callId: msg.callId, ok: true, value });
    } catch (err) {
      this.post({
        kind: "apiResult",
        callId: msg.callId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async dispatchApi(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case "window.showInformationMessage":
        toast(String(args[0] ?? ""));
        return undefined;
      case "window.showWarningMessage":
        toast.warning(String(args[0] ?? ""));
        return undefined;
      case "window.showErrorMessage":
        toast.error(String(args[0] ?? ""));
        return undefined;
      case "workspace.fs.readTextFile": {
        const result = await invoke<ReadResult>("fs_read_file", {
          path: String(args[0] ?? ""),
          workspace: currentWorkspaceEnv(),
        });
        if (result.kind === "text") return result.content;
        if (result.kind === "binary")
          throw new Error("cannot read binary file as text");
        throw new Error(`file too large (${result.size} bytes)`);
      }
      case "workspace.fs.writeTextFile":
        await invoke<void>("fs_write_file", {
          path: String(args[0] ?? ""),
          content: String(args[1] ?? ""),
          workspace: currentWorkspaceEnv(),
          source: "extension",
        });
        return undefined;
      default:
        throw new Error(`API not available: ${method}`);
    }
  }
}

/** Singleton host shared by the whole window. */
export const extensionHost = new ExtensionHost();
