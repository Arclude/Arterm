/**
 * RPC protocol between the main thread (host) and the extension-host Web
 * Worker. The worker runs untrusted extension code; it never touches the DOM
 * or the filesystem directly. Every capability is a message the host either
 * fulfils or rejects, so the host is the single permission-enforcement point.
 *
 * Two request/response channels are multiplexed over postMessage, each keyed by
 * a monotonic `callId`:
 *   - host → worker `invokeCommand` ⇒ worker → host `commandResult`
 *   - worker → host `apiCall`       ⇒ host → worker `apiResult`
 */

/** Messages the host sends into the worker. */
export type HostToWorker =
  | { kind: "activate"; extensionId: string; source: string }
  | { kind: "deactivate"; extensionId: string }
  | {
      kind: "invokeCommand";
      callId: number;
      extensionId: string;
      command: string;
      args: unknown[];
    }
  /** Resolution of a prior worker `apiCall`. */
  | {
      kind: "apiResult";
      callId: number;
      ok: boolean;
      value?: unknown;
      error?: string;
    };

/** Messages the worker sends back to the host. */
export type WorkerToHost =
  | { kind: "ready" }
  /** Activation finished; `error` set when the extension's code threw. */
  | { kind: "activated"; extensionId: string; error?: string }
  /** A command handler was bound during activation. */
  | { kind: "registeredCommand"; extensionId: string; command: string }
  /** Result of a host-initiated `invokeCommand`. */
  | {
      kind: "commandResult";
      callId: number;
      ok: boolean;
      value?: unknown;
      error?: string;
    }
  /** The extension is calling a host-mediated API; host must reply `apiResult`. */
  | {
      kind: "apiCall";
      callId: number;
      extensionId: string;
      method: string;
      args: unknown[];
    }
  | {
      kind: "log";
      extensionId: string;
      level: "log" | "warn" | "error";
      message: string;
    };
