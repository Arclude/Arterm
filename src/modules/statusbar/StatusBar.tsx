import {
  Add01Icon,
  File01Icon,
  IncognitoIcon,
  SidebarLeft01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { AgentStatusPill } from "@/modules/ai/components/AgentStatusPill";
import { AiStatusBarControls } from "@/modules/ai/components/AiStatusBarControls";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { WorkspaceEnv } from "@/modules/workspace";
import { BranchSwitcher } from "./BranchSwitcher";
import { Clock } from "./Clock";
import { CwdBreadcrumb } from "./CwdBreadcrumb";
import { useGitStatus } from "./useGitStatus";
import { VoiceButton } from "./VoiceButton";
import { WorkspaceEnvSelector } from "./WorkspaceEnvSelector";

type Props = {
  cwd: string | null;
  filePath?: string | null;
  home: string | null;
  onCd: (path: string) => void;
  onWorkspaceChange: (env: WorkspaceEnv) => void;
  onOpenMini: () => void;
  onNewTab: () => void;
  onToggleSidebar: () => void;
  /** Active terminal leaf — voice transcript is typed into it. */
  activeLeafId: number | null;
  /** Only rendered when the AI panel is open and a key is loaded. */
  hasComposer: boolean;
  privateActive: boolean;
};

const ICON_BTN =
  "flex h-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

export function StatusBar({
  cwd,
  filePath,
  home,
  onCd,
  onWorkspaceChange,
  onOpenMini,
  onNewTab,
  onToggleSidebar,
  activeLeafId,
  hasComposer,
  privateActive,
}: Props) {
  const { status: git, refresh: refreshGit } = useGitStatus(cwd);
  const items = usePreferencesStore((s) => s.statusBar);

  return (
    <footer className="flex h-8 shrink-0 items-center justify-between gap-3 border-t border-border/60 bg-card/60 px-2 text-[11px]">
      {/* Left: app + quick actions + git change stats */}
      <div className="flex shrink-0 items-center gap-1">
        <AgentStatusPill onClick={onOpenMini} />
        {items.newTab ? (
          <button
            type="button"
            title="New tab"
            onClick={onNewTab}
            className={cn(ICON_BTN, "w-6")}
          >
            <HugeiconsIcon icon={Add01Icon} size={14} strokeWidth={2} />
          </button>
        ) : null}
        {items.voice ? <VoiceButton activeLeafId={activeLeafId} /> : null}
        {items.explorer ? (
          <button
            type="button"
            title="Toggle file explorer"
            onClick={onToggleSidebar}
            className={cn(ICON_BTN, "gap-1.5 px-2")}
          >
            <HugeiconsIcon
              icon={SidebarLeft01Icon}
              size={12}
              strokeWidth={1.75}
            />
            <span className="text-[10.5px]">Explorer</span>
          </button>
        ) : null}
        {items.gitStats && git && git.changeCount > 0 ? (
          <span
            title={`${git.changeCount} changed file${git.changeCount > 1 ? "s" : ""}`}
            className="flex shrink-0 items-center gap-1 pl-1 text-[10.5px] text-muted-foreground tabular-nums"
          >
            <HugeiconsIcon icon={File01Icon} size={11} strokeWidth={1.75} />
            <span>{git.changeCount}</span>
            {git.insertions > 0 ? (
              <span className="text-emerald-600 dark:text-emerald-400">
                +{git.insertions}
              </span>
            ) : null}
            {git.deletions > 0 ? (
              <span className="text-red-600 dark:text-red-400">
                -{git.deletions}
              </span>
            ) : null}
          </span>
        ) : null}
        {privateActive ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex shrink-0 cursor-default items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10.5px] font-medium text-amber-700 dark:text-amber-400">
                <HugeiconsIcon icon={IncognitoIcon} size={11} strokeWidth={2} />
                <span>Private</span>
              </span>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              className="max-w-64 text-[11px] leading-relaxed"
            >
              AI can't see this terminal's output. Use it for secrets, SSH, or
              anything you don't want sent to the model.
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>

      {/* Right: path + branch + clock + AI controls */}
      <div className="flex min-w-0 items-center justify-end gap-2">
        {items.workspace ? (
          <WorkspaceEnvSelector onSelect={onWorkspaceChange} />
        ) : null}
        {items.cwd ? (
          <CwdBreadcrumb
            cwd={cwd}
            filePath={filePath}
            home={home}
            onCd={onCd}
          />
        ) : null}
        {items.gitBranch && git ? (
          <BranchSwitcher
            repoRoot={git.repoRoot}
            branch={git.branch}
            detached={git.detached}
            ahead={git.ahead}
            behind={git.behind}
            onChanged={refreshGit}
          />
        ) : null}
        {items.clock ? <Clock /> : null}
        {hasComposer ? <AiStatusBarControls /> : null}
      </div>
    </footer>
  );
}
