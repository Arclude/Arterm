import { useEffect, useRef } from "react";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { EditorGroupsState } from "@/modules/tabs/lib/editorGroups";
import type { Tab } from "@/modules/tabs/lib/useTabs";
import { clearSession, saveSession } from "./persistence";
import { buildSnapshot } from "./session";

const SAVE_DEBOUNCE_MS = 500;

/** Continuously persists the restorable tab state (debounced) so a crash or
 * abrupt close loses at most the last half second — no on-close flush to
 * race against webview teardown. */
export function useSessionPersistence(args: {
  tabs: Tab[];
  activeId: number;
  editorGroups: EditorGroupsState;
}): void {
  const { tabs, activeId, editorGroups } = args;
  const restoreSession = usePreferencesStore((s) => s.restoreSession);
  const hydrated = usePreferencesStore((s) => s.hydrated);
  const clearedRef = useRef(false);

  useEffect(() => {
    // Until prefs hydrate we don't know whether restore is enabled — saving
    // then could clobber a snapshot the user expects to keep.
    if (!hydrated) return;
    if (!restoreSession) {
      if (!clearedRef.current) {
        clearedRef.current = true;
        clearSession();
      }
      return;
    }
    clearedRef.current = false;
    const handle = setTimeout(() => {
      saveSession(buildSnapshot(tabs, activeId, editorGroups));
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [tabs, activeId, editorGroups, restoreSession, hydrated]);
}
