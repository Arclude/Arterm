import {
  ArrowRight01Icon,
  LayoutTwoColumnIcon,
  LayoutTwoRowIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { fileIconUrl } from "@/modules/explorer/lib/iconResolver";
import { relativizePath } from "./lib/pathUtils";

type Props = {
  path: string;
  workspaceRoot: string | null;
  /** Enclosing symbol chain at the cursor, e.g. ["Home"]. */
  symbolPath: string[];
  /** Split the current editor group; omitted when splitting is unavailable. */
  onSplit?: (dir: "row" | "col") => void;
};

// VS Code-style breadcrumb: workspace-relative path segments followed by the
// cursor's enclosing symbol chain. Sits between the group tab strip and the
// editor.
export function EditorBreadcrumb({
  path,
  workspaceRoot,
  symbolPath,
  onSplit,
}: Props) {
  const segments = relativizePath(path, workspaceRoot);
  if (segments.length === 0) return null;
  const fileName = segments[segments.length - 1];
  const crumbs = [...segments, ...symbolPath];

  return (
    <div className="flex h-6 shrink-0 items-center border-b border-border/40 text-[11px] text-muted-foreground">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-2.5 scrollbar-none">
        <img
          src={fileIconUrl(fileName)}
          alt=""
          draggable={false}
          className="size-3.5 shrink-0 opacity-80"
        />
        {crumbs.map((crumb, i) => {
          const isSymbol = i >= segments.length;
          return (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: positional crumbs
              key={i}
              className="flex shrink-0 items-center gap-1"
            >
              {i > 0 ? (
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  size={11}
                  className="opacity-40"
                />
              ) : null}
              <span className={isSymbol ? "text-foreground/80" : undefined}>
                {crumb}
              </span>
            </span>
          );
        })}
      </div>
      {onSplit ? (
        <div className="flex shrink-0 items-center gap-0.5 pe-1.5 ps-1">
          <button
            type="button"
            title="Split right"
            aria-label="Split right"
            onClick={() => onSplit("row")}
            className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
          >
            <HugeiconsIcon icon={LayoutTwoColumnIcon} size={13} />
          </button>
          <button
            type="button"
            title="Split down"
            aria-label="Split down"
            onClick={() => onSplit("col")}
            className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
          >
            <HugeiconsIcon icon={LayoutTwoRowIcon} size={13} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
