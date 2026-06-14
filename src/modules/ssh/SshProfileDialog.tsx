import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useEffect, useState } from "react";
import {
  type SshAuthMethod,
  type SshProfile,
  loadProfiles,
  newProfileId,
  saveProfiles,
  setSecret,
} from "./lib/sshProfiles";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Profile being edited, or null to create a new one. */
  initial: SshProfile | null;
  onSaved: () => void;
};

export function SshProfileDialog({ open, onOpenChange, initial, onSaved }: Props) {
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [auth, setAuth] = useState<SshAuthMethod>("key");
  const [keyPath, setKeyPath] = useState("");
  const [secret, setSecret_] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? "");
    setHost(initial?.host ?? "");
    setPort(String(initial?.port ?? 22));
    setUsername(initial?.username ?? "");
    setAuth(initial?.auth ?? "key");
    setKeyPath(initial?.keyPath ?? "");
    setSecret_("");
  }, [open, initial]);

  const canSave = name.trim() && host.trim() && username.trim();

  async function save() {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      const id = initial?.id ?? newProfileId();
      const profile: SshProfile = {
        id,
        name: name.trim(),
        host: host.trim(),
        port: Number(port) || 22,
        username: username.trim(),
        auth,
        ...(auth === "key" && keyPath.trim() ? { keyPath: keyPath.trim() } : {}),
        ...(initial?.knownHostKey ? { knownHostKey: initial.knownHostKey } : {}),
      };

      const profiles = await loadProfiles();
      const idx = profiles.findIndex((p) => p.id === id);
      if (idx >= 0) profiles[idx] = profile;
      else profiles.push(profile);
      await saveProfiles(profiles);

      // Stash the secret in the platform keychain, never in the profile JSON.
      if (auth === "password" && secret) await setSecret(id, "password", secret);
      if (auth === "key" && secret) await setSecret(id, "passphrase", secret);

      onSaved();
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{initial ? "Edit connection" : "New SSH connection"}</DialogTitle>
          <DialogDescription>
            Secrets are stored in your OS keychain, not in the profile file.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-1">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My server" />
          </Field>
          <div className="flex gap-2">
            <div className="flex-1">
              <Field label="Host">
                <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="example.com" />
              </Field>
            </div>
            <div className="w-20">
              <Field label="Port">
                <Input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
              </Field>
            </div>
          </div>
          <Field label="Username">
            <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="root" />
          </Field>
          <Field label="Authentication">
            <Select value={auth} onValueChange={(v) => setAuth(v as SshAuthMethod)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="key">Private key</SelectItem>
                <SelectItem value="password">Password</SelectItem>
                <SelectItem value="agent">SSH agent</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          {auth === "key" && (
            <>
              <Field label="Key path">
                <Input
                  value={keyPath}
                  onChange={(e) => setKeyPath(e.target.value)}
                  placeholder="~/.ssh/id_ed25519"
                />
              </Field>
              <Field label="Passphrase (optional)">
                <Input
                  type="password"
                  value={secret}
                  onChange={(e) => setSecret_(e.target.value)}
                  placeholder={initial ? "•••••• (unchanged)" : ""}
                />
              </Field>
            </>
          )}
          {auth === "password" && (
            <Field label="Password">
              <Input
                type="password"
                value={secret}
                onChange={(e) => setSecret_(e.target.value)}
                placeholder={initial ? "•••••• (unchanged)" : ""}
              />
            </Field>
          )}
          {auth === "agent" && (
            <p className="text-xs text-muted-foreground">
              Uses your running ssh-agent (or Pageant / OpenSSH agent on Windows).
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!canSave || saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
