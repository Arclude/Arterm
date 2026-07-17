import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  BugIcon,
  CommandLineIcon,
  FolderGitTwoIcon,
  FolderTreeIcon,
  ServerStack01Icon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import type { SidebarViewId } from "./types";

export const SIDEBAR_RAIL_HEIGHT = 36;

type RailItem = {
  // "cli-agents" both selects the sidebar panel AND opens the main-area tab, so
  // it's flagged as a launcher (App wires the combined behavior via onOpenCliAgents).
  id: SidebarViewId;
  label: string;
  icon: Parameters<typeof HugeiconsIcon>[0]["icon"];
  badge?: number;
  /** Opens a workspace-area tab instead of switching the sidebar view. */
  launcher?: boolean;
};

type Props = {
  activeView: SidebarViewId;
  onSelectView: (view: SidebarViewId) => void;
  changedCount: number;
  /** Agent sessions currently running or waiting on an approval. */
  busyAgentCount: number;
  /** Active agents across all connected Arterm CLI sessions. */
  cliAgentCount: number;
  /** Open (or focus) the CLI Agents dashboard tab in the workspace area. */
  onOpenCliAgents: () => void;
  /** Whether the CLI Agents dashboard tab is the active workspace tab. */
  cliAgentsActive: boolean;
  /** Live hover summary of every running CLI session (shown on the CLI button). */
  cliFlyout?: ReactNode;
  /** Any live session is actively working ⇒ pulse the CLI button. */
  cliBusy?: boolean;
  /** Reachable CLI sessions ⇒ a static presence dot when idle. */
  cliOnline?: number;
  /** Drop the animated ping (keep the static busy dot) — e.g. while a terminal
   *  tab is active, so the rail doesn't drive a per-frame animation. */
  subdued?: boolean;
};

export function SidebarRail({
  activeView,
  onSelectView,
  changedCount,
  busyAgentCount,
  cliAgentCount,
  onOpenCliAgents,
  cliAgentsActive,
  cliFlyout,
  cliBusy = false,
  cliOnline = 0,
  subdued = false,
}: Props) {
  const items: RailItem[] = [
    { id: "explorer", label: "Files", icon: FolderTreeIcon },
    {
      id: "source-control",
      label: "Source Control",
      icon: FolderGitTwoIcon,
      badge: changedCount,
    },
    { id: "debug", label: "Debug", icon: BugIcon },
    {
      id: "agents",
      label: "Agents",
      icon: SparklesIcon,
      badge: busyAgentCount,
    },
    {
      id: "cli-agents",
      label: "CLI Agents",
      icon: CommandLineIcon,
      badge: cliAgentCount,
      launcher: true,
    },
    { id: "ssh", label: "SSH", icon: ServerStack01Icon },
  ];

  return (
    <div
      style={{ height: SIDEBAR_RAIL_HEIGHT }}
      className="flex shrink-0 items-stretch gap-1 border-t border-border/60 bg-card/85 px-1.5 py-1 backdrop-blur"
    >
      {items.map((item) => {
        const isActive = item.launcher
          ? cliAgentsActive || activeView === "cli-agents"
          : item.id === activeView;
        const showBadge = !!item.badge && item.badge > 0;
        const showPulse = item.launcher && cliBusy;
        const showPresence = item.launcher && !cliBusy && cliOnline > 0;
        const trigger = (
          <button
            type="button"
            aria-label={item.label}
            aria-pressed={isActive}
            onClick={() =>
              item.launcher
                ? onOpenCliAgents()
                : onSelectView(item.id as SidebarViewId)
            }
            className={cn(
              "group relative flex flex-1 cursor-pointer items-center justify-center rounded-md outline-none transition-colors duration-150",
              "focus-visible:ring-2 focus-visible:ring-primary/40",
              isActive
                ? "bg-foreground/[0.07] text-foreground dark:bg-foreground/[0.09]"
                : "text-muted-foreground hover:bg-foreground/[0.045] hover:text-foreground",
            )}
          >
            <HugeiconsIcon
              icon={item.icon}
              size={15}
              strokeWidth={isActive ? 2 : 1.75}
              className="shrink-0 transition-[stroke-width] duration-150"
            />
            {showPulse ? (
              <span className="pointer-events-none absolute left-1 top-1 flex size-1.5">
                {subdued ? null : (
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400/70" />
                )}
                <span className="relative inline-flex size-1.5 rounded-full bg-emerald-400" />
              </span>
            ) : showPresence ? (
              <span className="pointer-events-none absolute left-1 top-1 size-1.5 rounded-full bg-muted-foreground/45" />
            ) : null}
            {showBadge ? (
              <span className="absolute right-1 top-0.5 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full border border-border/60 bg-card px-1 text-[9px] font-semibold leading-none tabular-nums text-muted-foreground/95">
                {item.badge! > 99 ? "99+" : item.badge}
              </span>
            ) : null}
          </button>
        );

        if (item.launcher && cliFlyout) {
          return (
            <HoverCard key={item.id} openDelay={140} closeDelay={90}>
              <HoverCardTrigger asChild>{trigger}</HoverCardTrigger>
              <HoverCardContent
                side="top"
                align="start"
                sideOffset={8}
                className="cli-dash w-[304px] overflow-hidden rounded-2xl p-0"
              >
                {cliFlyout}
              </HoverCardContent>
            </HoverCard>
          );
        }

        return (
          <Tooltip key={item.id}>
            <TooltipTrigger asChild>{trigger}</TooltipTrigger>
            <TooltipContent side="top" className="text-[11px]">
              {item.label}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
