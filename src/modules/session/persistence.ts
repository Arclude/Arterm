import { LazyStore } from "@tauri-apps/plugin-store";
import { wasLaunchDirExplicit } from "@/lib/launchDir";
import { readRestoreSessionPref } from "@/modules/settings/store";
import { parseSnapshot, type SessionSnapshotV1 } from "./session";

const STORE_PATH = "arterm-session.json";
const KEY_SNAPSHOT = "snapshot";

const store = new LazyStore(STORE_PATH, { defaults: {} });

let cached: SessionSnapshotV1 | null = null;

/** Load the saved session before first render (mirrors `initLaunchDir`).
 * Skipped when the user disabled restore or launched with an explicit
 * directory argument — that ask wins over the previous session. */
export async function initSessionRestore(): Promise<void> {
  if (wasLaunchDirExplicit()) return;
  try {
    if (!(await readRestoreSessionPref())) return;
    cached = parseSnapshot(await store.get<unknown>(KEY_SNAPSHOT));
  } catch {
    cached = null;
  }
}

/** Drained on first read so an HMR remount cannot replay the restore. */
export function getSavedSession(): SessionSnapshotV1 | null {
  const s = cached;
  cached = null;
  return s;
}

export function saveSession(snapshot: SessionSnapshotV1): void {
  void store
    .set(KEY_SNAPSHOT, snapshot)
    .then(() => store.save())
    .catch(() => {});
}

export function clearSession(): void {
  void store
    .delete(KEY_SNAPSHOT)
    .then(() => store.save())
    .catch(() => {});
}
