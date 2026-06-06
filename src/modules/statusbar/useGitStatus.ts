import { useCallback, useEffect, useRef, useState } from "react";
import { native } from "@/modules/ai/lib/native";
import { listenFsChanged, watchAdd } from "@/modules/explorer/lib/watch";

export type GitStatusInfo = {
  repoRoot: string;
  branch: string;
  detached: boolean;
  ahead: number;
  behind: number;
  changeCount: number;
  insertions: number;
  deletions: number;
};

export type UseGitStatus = {
  status: GitStatusInfo | null;
  refresh: () => void;
};

/**
 * Git status for a directory (the active terminal's cwd): branch, ahead/behind,
 * changed-file count, and +/- line totals. Returns null when not a git repo.
 * Refreshes on cwd change, window focus, working-tree file changes, and via the
 * returned `refresh` (e.g. after a branch switch).
 */
export function useGitStatus(cwd: string | null): UseGitStatus {
  const [info, setInfo] = useState<GitStatusInfo | null>(null);
  const repoRootRef = useRef<string | null>(null);

  const fetchStatus = useCallback(async () => {
    const root = repoRootRef.current;
    if (!root) return;
    try {
      const [status, stat] = await Promise.all([
        native.gitStatus(root),
        native.gitDiffStat(root).catch(() => null),
      ]);
      if (repoRootRef.current !== root) return; // cwd moved on
      setInfo({
        repoRoot: root,
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
  }, []);

  const refresh = useCallback(() => {
    void fetchStatus();
  }, [fetchStatus]);

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
  }, [cwd, fetchStatus]);

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
  }, [fetchStatus]);

  return { status: info, refresh };
}
