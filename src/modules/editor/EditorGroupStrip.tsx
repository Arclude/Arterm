import {
  Cancel01Icon,
  LayoutTwoColumnIcon,
  LayoutTwoRowIcon,
  MoreHorizontalIcon,
  PlayIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { debugController } from "@/modules/dap";
import { fileIconUrl } from "@/modules/explorer/lib/iconResolver";
import type { EditorGroup, EditorTab } from "@/modules/tabs";
import type { SplitDir } from "@/modules/terminal/lib/panes";
import {
  getDraggedTab,
  insertionIndex,
  setDraggedTab,
  TAB_MIME,
} from "./lib/tabDnd";

type Props = {
  groupId: number;
  group: EditorGroup;
  tabsById: Map<number, EditorTab>;
  isFocused: boolean;
  /** Workspace root, used as the debuggee cwd for Run/Debug. */
  workspaceRoot: string | null;
  onActivate: (tabId: number) => void;
  onClose: (tabId: number) => void;
  onSplit: (dir: SplitDir) => void;
  /** Move a dragged tab into this group at the given index. */
  onMoveTab: (tabId: number, toGroupId: number, index: number) => void;
};

// Per-group editor tab strip (VS Code editor-group header). Each split pane
// owns one of these: its own tabs, its own active tab, and split actions.
export function EditorGroupStrip({
  groupId,
  group,
  tabsById,
  isFocused,
  workspaceRoot,
  onActivate,
  onClose,
  onSplit,
  onMoveTab,
}: Props) {
  const stripRef = useRef<HTMLDivElement>(null);
  // Insertion marker shown while dragging a tab over this strip.
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const isTabDrag = (e: React.DragEvent) =>
    e.dataTransfer.types.includes(TAB_MIME);

  const activePath =
    group.activeTabId != null
      ? (tabsById.get(group.activeTabId)?.path ?? null)
      : null;
  const canDebug = !!activePath && activePath.toLowerCase().endsWith(".py");

  const runDebug = () => {
    if (!activePath) return;
    const cwd =
      workspaceRoot ?? (activePath.replace(/[\\/][^\\/]*$/, "") || ".");
    void debugController.start({ program: activePath, cwd });
  };

  const closeAll = () => {
    for (const id of [...group.tabIds]) onClose(id);
  };
  const closeOthers = () => {
    for (const id of [...group.tabIds]) {
      if (id !== group.activeTabId) onClose(id);
    }
  };

  // Horizontal wheel scroll without holding shift, matching the global TabBar.
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY !== 0 && e.deltaX === 0) {
        el.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div
      className={cn(
        "flex h-8 shrink-0 items-stretch border-b border-border/60 bg-card/60",
        isFocused && "bg-card",
      )}
    >
      <div
        ref={stripRef}
        onDragOver={(e) => {
          if (!isTabDrag(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          if (stripRef.current)
            setDropIndex(insertionIndex(e.clientX, stripRef.current));
        }}
        onDragLeave={(e) => {
          // Ignore leaves into child elements.
          if (!e.currentTarget.contains(e.relatedTarget as Node | null))
            setDropIndex(null);
        }}
        onDrop={(e) => {
          if (!isTabDrag(e)) return;
          e.preventDefault();
          e.stopPropagation();
          const id =
            Number(e.dataTransfer.getData(TAB_MIME)) || getDraggedTab();
          const idx =
            dropIndex ??
            (stripRef.current
              ? insertionIndex(e.clientX, stripRef.current)
              : group.tabIds.length);
          setDropIndex(null);
          if (id) onMoveTab(id, groupId, idx);
        }}
        className="flex min-w-0 flex-1 items-stretch overflow-x-auto scrollbar-none"
      >
        {group.tabIds.map((id, index) => {
          const t = tabsById.get(id);
          if (!t) return null;
          const active = id === group.activeTabId;
          return (
            <div
              key={id}
              role="tab"
              aria-selected={active}
              data-tab-index={index}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(TAB_MIME, String(id));
                e.dataTransfer.effectAllowed = "move";
                setDraggedTab(id);
              }}
              onDragEnd={() => {
                setDraggedTab(null);
                setDropIndex(null);
              }}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onClose(id);
                  return;
                }
                onActivate(id);
              }}
              className={cn(
                "group/tab relative flex max-w-[200px] shrink-0 cursor-pointer items-center gap-1.5 border-r border-border/40 px-2.5 text-[12px]",
                dropIndex === index &&
                  "before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:bg-primary before:content-['']",
                active
                  ? "bg-background text-foreground"
                  : "text-muted-foreground hover:bg-foreground/[0.03] hover:text-foreground/90",
              )}
            >
              {active && isFocused ? (
                <span className="absolute inset-x-0 top-0 h-[2px] bg-primary/80" />
              ) : null}
              <img
                src={fileIconUrl(t.path)}
                alt=""
                draggable={false}
                className="size-3.5 shrink-0 opacity-90"
              />
              <span
                className={cn("truncate", t.preview && "italic")}
                title={t.path}
              >
                {t.title}
              </span>
              {t.dirty ? (
                <span className="size-1.5 shrink-0 rounded-full bg-foreground/70 group-hover/tab:hidden" />
              ) : null}
              <button
                type="button"
                aria-label="Close"
                onMouseDown={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  onClose(id);
                }}
                className={cn(
                  "grid size-4 shrink-0 place-items-center rounded hover:bg-foreground/10",
                  !t.dirty && "opacity-0 group-hover/tab:opacity-100",
                )}
              >
                <HugeiconsIcon icon={Cancel01Icon} size={12} />
              </button>
            </div>
          );
        })}
        {dropIndex === group.tabIds.length && group.tabIds.length > 0 ? (
          <div className="my-1 w-0.5 shrink-0 self-stretch bg-primary" />
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-0.5 px-1">
        <button
          type="button"
          title="Split right"
          aria-label="Split right"
          onClick={() => onSplit("row")}
          className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
        >
          <HugeiconsIcon icon={LayoutTwoColumnIcon} size={14} />
        </button>
        <button
          type="button"
          title="Split down"
          aria-label="Split down"
          onClick={() => onSplit("col")}
          className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
        >
          <HugeiconsIcon icon={LayoutTwoRowIcon} size={14} />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title="More actions"
              aria-label="More actions"
              className="grid size-6 place-items-center rounded text-muted-foreground outline-none hover:bg-foreground/[0.06] hover:text-foreground"
            >
              <HugeiconsIcon icon={MoreHorizontalIcon} size={14} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            {canDebug ? (
              <>
                <DropdownMenuItem onSelect={runDebug}>
                  <HugeiconsIcon icon={PlayIcon} size={14} strokeWidth={1.75} />
                  <span className="flex-1">Run / Debug</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            ) : null}
            <DropdownMenuItem onSelect={() => onSplit("row")}>
              <HugeiconsIcon
                icon={LayoutTwoColumnIcon}
                size={14}
                strokeWidth={1.75}
              />
              <span className="flex-1">Split right</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onSplit("col")}>
              <HugeiconsIcon
                icon={LayoutTwoRowIcon}
                size={14}
                strokeWidth={1.75}
              />
              <span className="flex-1">Split down</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={closeOthers}
              disabled={group.tabIds.length < 2}
            >
              <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={1.75} />
              <span className="flex-1">Close other tabs</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={closeAll}>
              <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={1.75} />
              <span className="flex-1">Close all tabs</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
