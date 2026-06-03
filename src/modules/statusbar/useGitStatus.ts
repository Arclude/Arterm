import { useEffect, useRef, useState } from "react";
import { native } from "@/modules/ai/lib/native";
import { listenFsChanged, watchAdd } from "@/modules/explorer/lib/watch";

export type GitStatusInfo = {
  branch: string;
  detached: boolean;
  ahead: number;
  behind: number;
  changeCount: number;
  insertions: number;
  deletions: number;
};

/**
 * Git status for a directory (the active terminal's cwd): branch, ahead/behind,
 * changed-file count, and +/- line totals. Returns null when not a git repo.
 * Refreshes on cwd change, window focus, and working-tree file changes.
 */
export function useGitStatus(cwd: string | null): GitStatusInfo | null {
  const [info, setInfo] = useState<GitStatusInfo | null>(null);
  const repoRootRef = useRef<string | null>(null);

  const fetchStatus = async () => {
    const root = repoRootRef.current;
    if (!root) return;
    try {
      const [status, stat] = await Promise.all([
        native.gitStatus(root),
        native.gitDiffStat(root).catch(() => null),
      ]);
      if (repoRootRef.current !== root) return; // cwd moved on
      setInfo({
        branch: status.branch,
        detached: status.isDetached,
        ahead: status.ahead,
        behind: status.behind,
        changeCount: status.changedFiles.length,
        insertions: stat?.insertions ?? 0,
        deletions: stat?.deletions ?? 0,
      });
    } catch {
      /* transient errors are non-fatal; keep prior info */
    }
  };

  useEffect(() => {
    let cancelled = false;
    repoRootRef.current = null;
    if (!cwd) {
      setInfo(null);
      return;
    }
    const timer = setTimeout(() => {
      void native
        .gitResolveRepo(cwd)
        .then((repo) => {
          if (cancelled) return;
          if (!repo) {
            repoRootRef.current = null;
            setInfo(null);
            return;
          }
          repoRootRef.current = repo.repoRoot;
          watchAdd([repo.repoRoot]);
          return fetchStatus();
        })
        .catch(() => {
          if (!cancelled) setInfo(null);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  useEffect(() => {
    const onFocus = () => void fetchStatus();
    window.addEventListener("focus", onFocus);
    let unlisten: (() => void) | undefined;
    void listenFsChanged((paths) => {
      const root = repoRootRef.current;
      if (root && paths.some((p) => p.startsWith(root))) void fetchStatus();
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      window.removeEventListener("focus", onFocus);
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return info;
}
