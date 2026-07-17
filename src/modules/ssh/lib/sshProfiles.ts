import { invoke } from "@/platform/core";
import { LazyStore } from "@/platform/store";
import type { SshConnectConfig } from "./ssh-bridge";

export type SshAuthMethod = "key" | "password" | "agent";

/** Persisted, secret-free description of a saved SSH connection. Passwords and
 *  key passphrases live in the platform keychain, not here (see secret helpers). */
export type SshProfile = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: SshAuthMethod;
  /** Absolute path to the private key, for `auth === "key"`. */
  keyPath?: string;
  /** OpenSSH-format host key trusted on first connect (TOFU). */
  knownHostKey?: string;
};

const STORE_PATH = "arterm-ssh-profiles.json";
const KEY_PROFILES = "profiles";
const SECRET_SERVICE = "arterm-ssh";

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

export async function loadProfiles(): Promise<SshProfile[]> {
  const list = await store.get<SshProfile[]>(KEY_PROFILES);
  return list ?? [];
}

export async function saveProfiles(profiles: SshProfile[]): Promise<void> {
  await store.set(KEY_PROFILES, profiles);
  await store.save();
}

/** Persist the host key the user trusted on first connect, so later connects
 *  verify against it instead of re-prompting. */
export async function rememberHostKey(
  profileId: string,
  hostKey: string,
): Promise<void> {
  const profiles = await loadProfiles();
  const next = profiles.map((p) =>
    p.id === profileId ? { ...p, knownHostKey: hostKey } : p,
  );
  await saveProfiles(next);
}

export function newProfileId(): string {
  return `ssh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// ── Secrets (keychain) ──────────────────────────────────────────────────────
// Account layout: "<profileId>:password" and "<profileId>:passphrase".

function secretAccount(profileId: string, kind: "password" | "passphrase") {
  return `${profileId}:${kind}`;
}

export async function setSecret(
  profileId: string,
  kind: "password" | "passphrase",
  value: string,
): Promise<void> {
  await invoke("secrets_set", {
    service: SECRET_SERVICE,
    account: secretAccount(profileId, kind),
    password: value,
  });
}

export async function getSecret(
  profileId: string,
  kind: "password" | "passphrase",
): Promise<string | null> {
  return invoke<string | null>("secrets_get", {
    service: SECRET_SERVICE,
    account: secretAccount(profileId, kind),
  });
}

export async function deleteSecrets(profileId: string): Promise<void> {
  await Promise.all(
    (["password", "passphrase"] as const).map((kind) =>
      invoke("secrets_delete", {
        service: SECRET_SERVICE,
        account: secretAccount(profileId, kind),
      }).catch(() => {}),
    ),
  );
}

/** Resolve a profile (plus its keychain secrets) into a connect payload. */
export async function buildConnectConfig(
  profile: SshProfile,
): Promise<SshConnectConfig> {
  const base = {
    host: profile.host,
    port: profile.port,
    username: profile.username,
    knownHostKey: profile.knownHostKey ?? null,
  };
  switch (profile.auth) {
    case "password": {
      const password = (await getSecret(profile.id, "password")) ?? "";
      return { ...base, auth: { kind: "password", password } };
    }
    case "key": {
      const passphrase = (await getSecret(profile.id, "passphrase")) ?? undefined;
      return {
        ...base,
        auth: { kind: "key", path: profile.keyPath ?? "", passphrase },
      };
    }
    case "agent":
      return { ...base, auth: { kind: "agent" } };
  }
}
