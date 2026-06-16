import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { SftpBrowser } from "./SftpBrowser";
import { SshProfileDialog } from "./SshProfileDialog";
import {
  type HostKeyEvent,
  sshConnect,
  sshKnownHostDecision,
} from "./lib/ssh-bridge";
import {
  type SshProfile,
  buildConnectConfig,
  deleteSecrets,
  loadProfiles,
  rememberHostKey,
  saveProfiles,
} from "./lib/sshProfiles";

type Props = {
  /** Open a terminal tab bound to an established SSH connection. */
  onOpenTerminal: (connId: number, title: string) => void;
  /** Open a remote file in the editor (path is `ssh://<connId>/<remotePath>`). */
  onOpenFile: (path: string, pin?: boolean) => void;
};

type HostKeyPrompt = HostKeyEvent & { kind: "unknown" | "mismatch" };
type Browsing = { connId: number; title: string };

export function SshPanel({ onOpenTerminal, onOpenFile }: Props) {
  const [profiles, setProfiles] = useState<SshProfile[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<SshProfile | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<HostKeyPrompt | null>(null);
  const [browsing, setBrowsing] = useState<Browsing | null>(null);

  // Host-key events arrive before sshConnect() resolves; map them back here.
  const connectingProfile = useRef<SshProfile | null>(null);

  const refresh = useCallback(() => {
    void loadProfiles().then(setProfiles);
  }, []);

  useEffect(() => refresh(), [refresh]);

  useEffect(() => {
    const unlisten = [
      listen<HostKeyEvent>("ssh-hostkey-unknown", (e) =>
        setPrompt({ ...e.payload, kind: "unknown" }),
      ),
      listen<HostKeyEvent>("ssh-hostkey-mismatch", (e) =>
        setPrompt({ ...e.payload, kind: "mismatch" }),
      ),
    ];
    return () => {
      void Promise.all(unlisten).then((fns) => fns.forEach((f) => f()));
    };
  }, []);

  const runAction = useCallback(
    (profile: SshProfile, action: (connId: number) => void) => {
      setError(null);
      setConnectingId(profile.id);
      connectingProfile.current = profile;
      void (async () => {
        try {
          const config = await buildConnectConfig(profile);
          const connId = await sshConnect(config);
          action(connId);
        } catch (e) {
          setError(`${profile.name}: ${e}`);
        } finally {
          // Keep connectingProfile pointed at the last attempt so a host-key
          // prompt (which may resolve after this settles) can still map back.
          setConnectingId(null);
        }
      })();
    },
    [],
  );

  const openTerminal = useCallback(
    (p: SshProfile) => runAction(p, (id) => onOpenTerminal(id, p.name)),
    [runAction, onOpenTerminal],
  );

  const openFiles = useCallback(
    (p: SshProfile) =>
      runAction(p, (id) => setBrowsing({ connId: id, title: p.name })),
    [runAction],
  );

  async function acceptHostKey() {
    if (!prompt) return;
    const profile = connectingProfile.current;
    if (profile) await rememberHostKey(profile.id, prompt.key);
    if (prompt.kind === "unknown") {
      await sshKnownHostDecision(prompt.connId, true);
    } else {
      // The mismatched attempt was already refused by the backend; the new key
      // is now trusted, so the next connect will succeed.
      refresh();
      setError("Host key updated — connect again.");
    }
    setPrompt(null);
  }

  async function rejectHostKey() {
    if (prompt?.kind === "unknown") await sshKnownHostDecision(prompt.connId, false);
    setPrompt(null);
  }

  async function remove(profile: SshProfile) {
    const next = profiles.filter((p) => p.id !== profile.id);
    await saveProfiles(next);
    await deleteSecrets(profile.id);
    refresh();
  }

  if (browsing) {
    return (
      <SftpBrowser
        connId={browsing.connId}
        title={browsing.title}
        onClose={() => setBrowsing(null)}
        onOpenFile={onOpenFile}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          SSH Connections
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          + Add
        </Button>
      </div>

      {error && (
        <p className="mx-3 mb-1 rounded bg-destructive/10 px-2 py-1 text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {profiles.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            No saved connections yet.
          </p>
        ) : (
          profiles.map((p) => (
            <div
              key={p.id}
              className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-foreground/[0.045]"
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 cursor-pointer flex-col items-start text-left"
                onClick={() => openTerminal(p)}
                disabled={connectingId === p.id}
              >
                <span className="truncate text-sm text-foreground">{p.name}</span>
                <span className="truncate text-[11px] text-muted-foreground">
                  {p.username}@{p.host}
                  {p.port !== 22 ? `:${p.port}` : ""}
                  {connectingId === p.id ? " — connecting…" : ""}
                </span>
              </button>
              <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5 text-[11px]"
                  onClick={() => openFiles(p)}
                  title="Browse files (SFTP)"
                >
                  Files
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5 text-[11px]"
                  onClick={() => {
                    setEditing(p);
                    setDialogOpen(true);
                  }}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5 text-[11px] text-destructive"
                  onClick={() => remove(p)}
                >
                  Delete
                </Button>
              </div>
            </div>
          ))
        )}
      </div>

      <SshProfileDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initial={editing}
        onSaved={refresh}
      />

      <Dialog open={!!prompt} onOpenChange={(o) => !o && rejectHostKey()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {prompt?.kind === "mismatch"
                ? "⚠ Host key changed"
                : "Unknown host key"}
            </DialogTitle>
            <DialogDescription>
              {prompt?.kind === "mismatch"
                ? "The server's key does not match the one you trusted before. This can mean a man-in-the-middle attack — only continue if you know why it changed."
                : "You're connecting to this host for the first time. Verify the fingerprint before trusting it."}
            </DialogDescription>
          </DialogHeader>
          <code className="block break-all rounded bg-muted px-2 py-1.5 text-xs">
            {prompt?.fingerprint}
          </code>
          <DialogFooter>
            <Button variant="ghost" onClick={rejectHostKey}>
              Cancel
            </Button>
            <Button onClick={acceptHostKey}>
              {prompt?.kind === "mismatch" ? "Trust new key" : "Trust & connect"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
