import { Channel, invoke } from "@/platform/core";

// Thin bridge over the Rust lsp_* commands. The backend handles process
// lifecycle and Content-Length framing; here we only shuttle whole JSON
// strings. Mirrors terminal/lib/pty-bridge.ts.

export type LspTransport = {
  id: number;
  send: (message: string) => Promise<void>;
  stop: () => Promise<void>;
};

export type StartLspOptions = {
  languageId: string;
  command: string;
  args: string[];
  cwd: string;
  onMessage: (message: string) => void;
};

export async function startLspServer(
  opts: StartLspOptions,
): Promise<LspTransport> {
  const onMessage = new Channel<string>();
  const noop = () => {};
  onMessage.onmessage = (msg) => opts.onMessage(msg);

  const id = await invoke<number>("lsp_start", {
    languageId: opts.languageId,
    command: opts.command,
    args: opts.args,
    cwd: opts.cwd,
    onMessage,
  });

  let stopped = false;
  return {
    id,
    send: (message) => invoke("lsp_send", { id, message }),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      onMessage.onmessage = noop;
      await invoke("lsp_stop", { id });
    },
  };
}
