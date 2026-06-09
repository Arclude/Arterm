import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { fileIconUrl } from "@/modules/explorer/lib/iconResolver";
import { relativizePath } from "./lib/pathUtils";

type Props = {
  path: string;
  workspaceRoot: string | null;
  /** Enclosing symbol chain at the cursor, e.g. ["Home"]. */
  symbolPath: string[];
};

// VS Code-style breadcrumb: workspace-relative path segments followed by the
// cursor's enclosing symbol chain. Sits between the group tab strip and the
// editor.
export function EditorBreadcrumb({ path, workspaceRoot, symbolPath }: Props) {
  const segments = relativizePath(path, workspaceRoot);
  if (segments.length === 0) return null;
  const fileName = segments[segments.length - 1];
  const crumbs = [...segments, ...symbolPath];

  return (
    <div className="flex h-6 shrink-0 items-center gap-1 overflow-x-auto border-b border-border/40 px-2.5 text-[11px] text-muted-foreground scrollbar-none">
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
  );
}
