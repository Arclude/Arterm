import { Channel, invoke } from "@/platform/core";

// Thin bridge over the Rust dap_* commands. The backend handles process
// lifecycle and Content-Length framing; here we only shuttle whole JSON
// strings. Mirrors lsp/transport.ts.

export type DapTransport = {
  id: number;
  send: (message: string) => Promise<void>;
  stop: () => Promise<void>;
};

export type StartDapOptions = {
  command: string;
  args: string[];
  cwd: string;
  onMessage: (message: string) => void;
};

export async function startDebugAdapter(
  opts: StartDapOptions,
): Promise<DapTransport> {
  const onMessage = new Channel<string>();
  const noop = () => {};
  onMessage.onmessage = (msg) => opts.onMessage(msg);

  const id = await invoke<number>("dap_start", {
    command: opts.command,
    args: opts.args,
    cwd: opts.cwd,
    onMessage,
  });

  let stopped = false;
  return {
    id,
    send: (message) => invoke("dap_send", { id, message }),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      onMessage.onmessage = noop;
      await invoke("dap_stop", { id });
    },
  };
}

// Reap adapters orphaned by a previous frontend (e.g. after an HMR reload).
export async function stopAllDebugAdapters(): Promise<void> {
  try {
    await invoke("dap_stop_all");
  } catch {
    // best-effort
  }
}
