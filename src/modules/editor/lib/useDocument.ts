import { invoke } from "@/platform/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { usePreferencesStore } from "@/modules/settings/preferences";

type ReadResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

type DataUrlResult = { dataUrl: string; size: number };

export type DocumentState =
  | { status: "loading" }
  | { status: "ready"; content: string; size: number }
  | { status: "image"; dataUrl: string; size: number }
  | { status: "binary"; size: number }
  | { status: "toolarge"; size: number; limit: number }
  | { status: "error"; message: string };

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "avif",
]);

/** Raster image types we render inline instead of opening in CodeMirror.
 *  SVG is intentionally excluded so it stays editable as markup. */
export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return IMAGE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

// --- Shared text-document registry -------------------------------------------
// When the same file is open in more than one editor pane (e.g. a split view),
// every pane must edit ONE underlying buffer so typing in one is reflected in
// the others and saves never clobber each other. Each text document is shared
// here, keyed by path, with the set of live panes subscribed to it. The entry
// is created synchronously on first load so a sibling pane mounting in the same
// commit reuses it instead of racing a second disk read.

type DocSnapshot = { buffer: string; saved: string; size: number };
type SharedListener = (snapshot: DocSnapshot) => void;

type SharedDoc = {
  saved: string;
  buffer: string;
  size: number;
  loaded: boolean;
  listeners: Set<SharedListener>;
};

const sharedDocs = new Map<string, SharedDoc>();

function notifyShared(path: string, except?: SharedListener | null): void {
  const entry = sharedDocs.get(path);
  if (!entry) return;
  const snapshot: DocSnapshot = {
    buffer: entry.buffer,
    saved: entry.saved,
    size: entry.size,
  };
  for (const listener of entry.listeners) {
    if (listener !== except) listener(snapshot);
  }
}

type Options = {
  path: string;
  onDirtyChange?: (dirty: boolean) => void;
};

/** Remote SFTP documents are addressed as `ssh://<connId>/<remotePath>`. */
function isRemotePath(path: string): boolean {
  return path.startsWith("ssh://");
}

/** `ssh://5//root/x` → { connId: 5, remote: "/root/x" } (leading slash kept). */
function parseRemotePath(path: string): { connId: number; remote: string } {
  const rest = path.slice("ssh://".length);
  const slash = rest.indexOf("/");
  if (slash < 0) return { connId: Number(rest), remote: "/" };
  return { connId: Number(rest.slice(0, slash)), remote: rest.slice(slash + 1) };
}

/** Read a document as text — routes remote paths through SFTP. */
async function readDocText(path: string): Promise<ReadResult> {
  if (isRemotePath(path)) {
    const { connId, remote } = parseRemotePath(path);
    const content = await invoke<string>("ssh_sftp_read", {
      connId,
      path: remote,
    });
    return { kind: "text", content, size: content.length };
  }
  return invoke<ReadResult>("fs_read_file", {
    path,
    workspace: currentWorkspaceEnv(),
  });
}

/** Read a document as a data URL (images). Remote binaries aren't supported yet. */
async function readDocDataUrl(path: string): Promise<DataUrlResult> {
  if (isRemotePath(path)) {
    throw new Error("Opening image/binary files over SSH isn't supported yet.");
  }
  return invoke<DataUrlResult>("fs_read_file_data_url", {
    path,
    workspace: currentWorkspaceEnv(),
  });
}

/** Persist a document — routes remote paths through SFTP (CREATE|TRUNCATE). */
async function writeDocText(path: string, content: string): Promise<void> {
  if (isRemotePath(path)) {
    const { connId, remote } = parseRemotePath(path);
    await invoke("ssh_sftp_write", { connId, path: remote, contents: content });
    return;
  }
  await invoke("fs_write_file", {
    path,
    content,
    workspace: currentWorkspaceEnv(),
    source: "editor",
  });
}

export function useDocument({ path, onDirtyChange }: Options) {
  const [doc, setDoc] = useState<DocumentState>({ status: "loading" });
  const [dirty, setDirty] = useState(false);

  const autoSave = usePreferencesStore((s) => s.editorAutoSave);
  const autoSaveDelay = usePreferencesStore((s) => s.editorAutoSaveDelay);

  // Track the saved/current buffer so we can detect changes cheaply. These
  // mirror this path's shared registry entry.
  const savedRef = useRef<string>("");
  const bufferRef = useRef<string>("");
  const dirtyRef = useRef(false);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  const autoSaveRef = useRef({ autoSave, autoSaveDelay });
  autoSaveRef.current = { autoSave, autoSaveDelay };

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearAutoSaveTimer = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  // This pane's listener identity, so siblings can push live updates and so we
  // can exclude ourselves when broadcasting our own edits.
  const listenerRef = useRef<SharedListener | null>(null);

  const saveNow = useCallback(async () => {
    const content = bufferRef.current;
    await writeDocText(path, content);
    savedRef.current = content;
    const entry = sharedDocs.get(path);
    if (entry) {
      entry.saved = content;
      notifyShared(path, listenerRef.current);
    }
    setDirty(false);
  }, [path]);

  // Notify parent of dirty transitions.
  const onDirtyChangeRef = useRef(onDirtyChange);
  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
  }, [onDirtyChange]);
  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);

  // Load on path change (or reuse a buffer already shared by another pane) and
  // subscribe this pane to live updates from siblings editing the same file.
  useEffect(() => {
    let cancelled = false;

    const listener: SharedListener = ({ buffer, saved, size }) => {
      if (cancelled) return;
      bufferRef.current = buffer;
      savedRef.current = saved;
      setDirty(buffer !== saved);
      setDoc({ status: "ready", content: buffer, size });
    };
    listenerRef.current = listener;

    // Images / binaries aren't text and aren't shared.
    if (isImagePath(path)) {
      setDoc({ status: "loading" });
      setDirty(false);
      readDocDataUrl(path)
        .then((res) => {
          if (cancelled) return;
          setDoc({ status: "image", dataUrl: res.dataUrl, size: res.size });
        })
        .catch((e) => {
          if (!cancelled) setDoc({ status: "error", message: String(e) });
        });
      return () => {
        cancelled = true;
        listenerRef.current = null;
      };
    }

    // Another pane already holds this file — reuse its live buffer.
    const existing = sharedDocs.get(path);
    if (existing) {
      existing.listeners.add(listener);
      if (existing.loaded) {
        bufferRef.current = existing.buffer;
        savedRef.current = existing.saved;
        setDirty(existing.buffer !== existing.saved);
        setDoc({
          status: "ready",
          content: existing.buffer,
          size: existing.size,
        });
      } else {
        setDoc({ status: "loading" });
        setDirty(false);
      }
      return () => {
        cancelled = true;
        existing.listeners.delete(listener);
        if (existing.listeners.size === 0) sharedDocs.delete(path);
        listenerRef.current = null;
      };
    }

    // First pane for this path: reserve the entry synchronously, then fill it.
    const entry: SharedDoc = {
      saved: "",
      buffer: "",
      size: 0,
      loaded: false,
      listeners: new Set([listener]),
    };
    sharedDocs.set(path, entry);
    setDoc({ status: "loading" });
    setDirty(false);

    readDocText(path)
      .then((res) => {
        if (res.kind === "text") {
          entry.saved = res.content;
          entry.buffer = res.content;
          entry.size = res.size;
          entry.loaded = true;
          // Notify all subscribers (including this pane) → ready.
          notifyShared(path);
        } else {
          // Not text — drop the shared entry and render locally.
          sharedDocs.delete(path);
          if (cancelled) return;
          if (res.kind === "binary") {
            setDoc({ status: "binary", size: res.size });
          } else if (res.kind === "toolarge") {
            setDoc({ status: "toolarge", size: res.size, limit: res.limit });
          }
        }
      })
      .catch((e) => {
        sharedDocs.delete(path);
        if (!cancelled) setDoc({ status: "error", message: String(e) });
      });

    return () => {
      cancelled = true;
      const e = sharedDocs.get(path);
      if (e) {
        e.listeners.delete(listener);
        if (e.listeners.size === 0) sharedDocs.delete(path);
      }
      listenerRef.current = null;
    };
  }, [path]);

  // Skipped while dirty (never clobber unsaved edits) and when disk already
  // matches the buffer (self-save / duplicate watcher event → no re-render).
  const reload = useCallback((): boolean => {
    if (dirtyRef.current) return false;
    if (isImagePath(path)) {
      void readDocDataUrl(path)
        .then((res) =>
          setDoc({ status: "image", dataUrl: res.dataUrl, size: res.size }),
        )
        .catch((e) => setDoc({ status: "error", message: String(e) }));
      return true;
    }
    void readDocText(path)
      .then((res) => {
        if (res.kind === "text") {
          if (res.content === savedRef.current) return;
          savedRef.current = res.content;
          bufferRef.current = res.content;
          const entry = sharedDocs.get(path);
          if (entry) {
            entry.saved = res.content;
            entry.buffer = res.content;
            entry.size = res.size;
            entry.loaded = true;
            notifyShared(path, listenerRef.current);
          }
          setDirty(false);
          setDoc({ status: "ready", content: res.content, size: res.size });
        } else if (res.kind === "binary") {
          setDoc({ status: "binary", size: res.size });
        } else if (res.kind === "toolarge") {
          setDoc({ status: "toolarge", size: res.size, limit: res.limit });
        }
      })
      .catch((e) => setDoc({ status: "error", message: String(e) }));
    return true;
  }, [path]);

  const save = useCallback(async () => {
    clearAutoSaveTimer();
    if (!dirty) return;
    await saveNow();
  }, [dirty, clearAutoSaveTimer, saveNow]);

  const onChange = useCallback(
    (next: string) => {
      bufferRef.current = next;
      const isDirty = next !== savedRef.current;
      setDirty(isDirty);

      // Broadcast the edit to sibling panes (not ourselves). Guard against the
      // echo when our own value prop updates from a sibling's change.
      const entry = sharedDocs.get(path);
      if (entry && entry.buffer !== next) {
        entry.buffer = next;
        notifyShared(path, listenerRef.current);
      }

      clearAutoSaveTimer();

      const { autoSave: active, autoSaveDelay: delay } = autoSaveRef.current;
      if (active && isDirty) {
        timeoutRef.current = setTimeout(() => {
          saveNow().catch((e) => console.error("[autosave]", e));
        }, delay);
      }
    },
    [path, clearAutoSaveTimer, saveNow],
  );

  useEffect(() => clearAutoSaveTimer, [path, clearAutoSaveTimer]);

  return { doc, dirty, onChange, save, reload };
}
