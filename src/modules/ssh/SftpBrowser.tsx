import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type SftpEntry,
  joinRemote,
  localBaseName,
  parentRemote,
  sftpDelete,
  sftpList,
  sftpMkdir,
  sftpUpload,
} from "./lib/sftp-bridge";

type Props = {
  connId: number;
  title: string;
  onClose: () => void;
};

export function SftpBrowser({ connId, title, onClose }: Props) {
  const [path, setPath] = useState(".");
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const pathRef = useRef(path);
  pathRef.current = path;

  const load = useCallback(
    async (p: string) => {
      setLoading(true);
      setError(null);
      try {
        setEntries(await sftpList(connId, p));
        setPath(p);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [connId],
  );

  useEffect(() => {
    void load(".");
  }, [load]);

  // Drag a local file onto the panel to upload it into the current directory.
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent(async (e) => {
      const p = e.payload;
      if (p.type === "over") {
        setDropActive(true);
        return;
      }
      if (p.type === "leave") {
        setDropActive(false);
        return;
      }
      if (p.type === "drop") {
        setDropActive(false);
        if (!p.paths.length) return;
        try {
          for (const local of p.paths) {
            // The dropped file is an explicit user choice; authorize its path
            // so the backend fs gate permits reading it for the upload.
            await invoke("workspace_authorize", { path: local });
            await sftpUpload(
              connId,
              local,
              joinRemote(pathRef.current, localBaseName(local)),
            );
          }
          await load(pathRef.current);
        } catch (err) {
          setError(String(err));
        }
      }
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, [connId, load]);

  async function createFolder() {
    const name = newFolder?.trim();
    setNewFolder(null);
    if (!name) return;
    try {
      await sftpMkdir(connId, joinRemote(path, name));
      await load(path);
    } catch (e) {
      setError(String(e));
    }
  }

  async function remove(entry: SftpEntry) {
    try {
      await sftpDelete(connId, joinRemote(path, entry.name), entry.isDir);
      await load(path);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div
      className={
        "flex h-full min-h-0 flex-col" +
        (dropActive ? " ring-2 ring-inset ring-primary/50" : "")
      }
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <button
          type="button"
          className="truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
          onClick={onClose}
          title="Back to connections"
        >
          ‹ {title}
        </button>
        <div className="flex shrink-0 gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            onClick={() => setNewFolder("")}
          >
            + Folder
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            onClick={() => load(path)}
          >
            ⟳
          </Button>
        </div>
      </div>

      <div className="truncate px-3 pb-1 text-[11px] text-muted-foreground" title={path}>
        {path === "." ? "~" : path}
      </div>

      {error && (
        <p className="mx-3 mb-1 rounded bg-destructive/10 px-2 py-1 text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {newFolder !== null && (
          <div className="px-1 py-1">
            <Input
              autoFocus
              value={newFolder}
              placeholder="New folder name"
              onChange={(e) => setNewFolder(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void createFolder();
                if (e.key === "Escape") setNewFolder(null);
              }}
              onBlur={() => void createFolder()}
              className="h-7 text-xs"
            />
          </div>
        )}

        <button
          type="button"
          className="flex w-full cursor-pointer items-center rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-foreground/[0.045]"
          onClick={() => load(parentRemote(path))}
        >
          ../
        </button>

        {loading ? (
          <p className="px-2 py-4 text-center text-xs text-muted-foreground">Loading…</p>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.name}
              className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-foreground/[0.045]"
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                onClick={() =>
                  entry.isDir ? load(joinRemote(path, entry.name)) : undefined
                }
              >
                <span className="text-sm">{entry.isDir ? "📁" : "📄"}</span>
                <span className="truncate text-sm text-foreground">{entry.name}</span>
                {!entry.isDir && (
                  <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground">
                    {formatSize(entry.size)}
                  </span>
                )}
              </button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 shrink-0 px-1.5 text-[11px] text-destructive opacity-0 transition-opacity group-hover:opacity-100"
                onClick={() => remove(entry)}
              >
                Delete
              </Button>
            </div>
          ))
        )}
      </div>

      <p className="border-t border-border/60 px-3 py-1.5 text-[10px] text-muted-foreground">
        Drag files here to upload
      </p>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
