/// <reference lib="webworker" />
/**
 * The extension host sandbox. Runs inside a Web Worker — no DOM, no direct
 * filesystem, no Tauri APIs. Untrusted extension code executes here; anything
 * it needs from the app is requested over postMessage and granted (or denied)
 * by the host on the main thread.
 *
 * An extension's entry source is run with `arterm`, `module`, `exports`, and a
 * sandboxed `console` in scope. It is expected to assign `exports.activate` and
 * optionally `exports.deactivate`, mirroring the VS Code activation contract.
 */
import type { HostToWorker, WorkerToHost } from "./protocol";

const post = (msg: WorkerToHost) =>
  (self as DedicatedWorkerGlobalScope).postMessage(msg);

/** Bound command handlers, keyed by command id (across all extensions). */
const commandHandlers = new Map<string, (...args: unknown[]) => unknown>();
/** Which extension registered each command, so we can scope cleanup. */
const commandOwners = new Map<string, string>();
/** Extensions whose code has run and `activate()` resolved. */
const activated = new Set<string>();
/** `deactivate` hooks captured at activation. */
const deactivators = new Map<string, () => unknown>();

/** Pending host-API calls awaiting an `apiResult`. */
let apiSeq = 1;
const pendingApi = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: unknown) => void }
>();

/** Build the `arterm` API object handed to one extension's code. */
function makeApi(extensionId: string) {
  const call = (method: string, args: unknown[]): Promise<unknown> => {
    const callId = apiSeq++;
    return new Promise((resolve, reject) => {
      pendingApi.set(callId, { resolve, reject });
      post({ kind: "apiCall", callId, extensionId, method, args });
    });
  };

  return {
    commands: {
      registerCommand(
        command: string,
        handler: (...args: unknown[]) => unknown,
      ) {
        commandHandlers.set(command, handler);
        commandOwners.set(command, extensionId);
        post({ kind: "registeredCommand", extensionId, command });
        return {
          dispose() {
            commandHandlers.delete(command);
            commandOwners.delete(command);
          },
        };
      },
      executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
        const local = commandHandlers.get(command);
        if (local) return Promise.resolve(local(...args));
        return call("commands.executeCommand", [command, ...args]);
      },
    },
    window: {
      showInformationMessage: (message: string) =>
        call("window.showInformationMessage", [message]),
      showWarningMessage: (message: string) =>
        call("window.showWarningMessage", [message]),
      showErrorMessage: (message: string) =>
        call("window.showErrorMessage", [message]),
    },
    workspace: {
      fs: {
        /** Read a workspace file as text. Requires the `fs:read` permission. */
        readTextFile: (path: string) =>
          call("workspace.fs.readTextFile", [path]) as Promise<string>,
        /** Write text to a workspace file. Requires the `fs:write` permission. */
        writeTextFile: (path: string, content: string) =>
          call("workspace.fs.writeTextFile", [path, content]) as Promise<void>,
      },
    },
  };
}

function makeConsole(extensionId: string) {
  const send = (level: "log" | "warn" | "error", args: unknown[]) =>
    post({
      kind: "log",
      extensionId,
      level,
      message: args
        .map((a) => {
          try {
            return typeof a === "string" ? a : JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(" "),
    });
  return {
    log: (...a: unknown[]) => send("log", a),
    info: (...a: unknown[]) => send("log", a),
    warn: (...a: unknown[]) => send("warn", a),
    error: (...a: unknown[]) => send("error", a),
  };
}

async function activate(extensionId: string, source: string) {
  if (activated.has(extensionId)) {
    post({ kind: "activated", extensionId });
    return;
  }
  try {
    const arterm = makeApi(extensionId);
    const consoleProxy = makeConsole(extensionId);
    const module: { exports: Record<string, unknown> } = { exports: {} };
    // Run the extension's entry source. `new Function` keeps it out of this
    // module's lexical scope; the worker boundary is the real sandbox.
    const run = new Function(
      "arterm",
      "module",
      "exports",
      "console",
      source,
    ) as (
      arterm: unknown,
      module: unknown,
      exports: unknown,
      console: unknown,
    ) => void;
    run(arterm, module, module.exports, consoleProxy);

    const activateFn = module.exports.activate;
    if (typeof activateFn === "function") {
      await activateFn({ subscriptions: [] as Array<{ dispose(): unknown }> });
    }
    const deactivateFn = module.exports.deactivate;
    if (typeof deactivateFn === "function") {
      deactivators.set(extensionId, deactivateFn as () => unknown);
    }
    activated.add(extensionId);
    post({ kind: "activated", extensionId });
  } catch (err) {
    const message =
      err instanceof Error ? (err.stack ?? err.message) : String(err);
    post({ kind: "activated", extensionId, error: message });
  }
}

async function deactivate(extensionId: string) {
  try {
    await deactivators.get(extensionId)?.();
  } catch {
    // best-effort teardown
  }
  deactivators.delete(extensionId);
  activated.delete(extensionId);
  for (const [command, owner] of commandOwners) {
    if (owner === extensionId) {
      commandHandlers.delete(command);
      commandOwners.delete(command);
    }
  }
}

self.onmessage = async (e: MessageEvent<HostToWorker>) => {
  const msg = e.data;
  switch (msg.kind) {
    case "activate":
      await activate(msg.extensionId, msg.source);
      break;
    case "deactivate":
      await deactivate(msg.extensionId);
      break;
    case "invokeCommand": {
      const handler = commandHandlers.get(msg.command);
      if (!handler) {
        post({
          kind: "commandResult",
          callId: msg.callId,
          ok: false,
          error: `command not registered: ${msg.command}`,
        });
        break;
      }
      try {
        const value = await handler(...msg.args);
        post({ kind: "commandResult", callId: msg.callId, ok: true, value });
      } catch (err) {
        post({
          kind: "commandResult",
          callId: msg.callId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }
    case "apiResult": {
      const pending = pendingApi.get(msg.callId);
      if (!pending) break;
      pendingApi.delete(msg.callId);
      if (msg.ok) pending.resolve(msg.value);
      else pending.reject(new Error(msg.error ?? "host API error"));
      break;
    }
  }
};

post({ kind: "ready" });
