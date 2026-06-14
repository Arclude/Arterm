import { invoke, Channel } from "@tauri-apps/api/core";
import type { PtyHandlers, PtySession } from "@/modules/terminal/lib/pty-bridge";

/** Auth payload sent to the backend. Secrets are resolved from the keychain on
 *  the frontend before this is built (see {@link buildConnectConfig}). */
export type SshAuth =
  | { kind: "password"; password: string }
  | { kind: "key"; path: string; passphrase?: string }
  | { kind: "agent" };

export type SshConnectConfig = {
  host: string;
  port: number;
  username: string;
  auth: SshAuth;
  /** Previously trusted host key (OpenSSH line). Omit to trigger a TOFU prompt. */
  knownHostKey?: string | null;
};

/** Host-key prompt payloads emitted by the backend during `ssh_connect`. */
export type HostKeyEvent = {
  connId: number;
  fingerprint: string;
  key: string;
};

/** Open an authenticated transport. Resolves to a connection id once auth
 *  succeeds. While pending, the backend may emit `ssh-hostkey-unknown` /
 *  `ssh-hostkey-mismatch`; resolve the former with {@link sshKnownHostDecision}. */
export async function sshConnect(config: SshConnectConfig): Promise<number> {
  return invoke<number>("ssh_connect", { config });
}

export async function sshDisconnect(connId: number): Promise<void> {
  await invoke("ssh_disconnect", { connId });
}

/** Answer a pending `ssh-hostkey-unknown` prompt for a connecting transport. */
export async function sshKnownHostDecision(
  connId: number,
  accept: boolean,
): Promise<void> {
  await invoke("ssh_known_host_decision", { connId, accept });
}

/**
 * Open an interactive shell over an existing connection. The returned session
 * is shape-compatible with the local {@link PtySession}, so the terminal hook
 * and renderer pool drive it identically.
 */
export async function openSshShell(
  connId: number,
  cols: number,
  rows: number,
  handlers: PtyHandlers,
): Promise<PtySession> {
  const onData = new Channel<ArrayBuffer>();
  const onExit = new Channel<number>();

  let released = false;
  const noop = () => {};
  const releaseHandlers = () => {
    if (released) return;
    released = true;
    onData.onmessage = noop;
    onExit.onmessage = noop;
  };

  onData.onmessage = (buf) => handlers.onData(new Uint8Array(buf));
  onExit.onmessage = (code) => {
    handlers.onExit?.(code);
    releaseHandlers();
  };

  const id = await invoke<number>("ssh_open_shell", {
    connId,
    cols,
    rows,
    onData,
    onExit,
  });

  let closed = false;
  return {
    id,
    write: (data) => invoke("ssh_write", { id, data }),
    resize: (c, r) => invoke("ssh_resize", { id, cols: c, rows: r }),
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await invoke("ssh_close", { id });
      } finally {
        releaseHandlers();
      }
    },
  };
}
