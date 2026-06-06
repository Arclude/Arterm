import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { native, type GitBranchList } from "@/modules/ai/lib/native";
import {
  Add01Icon,
  GitBranchIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

type Props = {
  repoRoot: string;
  branch: string;
  detached: boolean;
  ahead: number;
  behind: number;
  onChanged: () => void;
};

function normalizeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const m = (error as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "Branch switch failed";
}

export function BranchSwitcher({
  repoRoot,
  branch,
  detached,
  ahead,
  behind,
  onChanged,
}: Props) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<GitBranchList | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    void native
      .gitListBranches(repoRoot)
      .then((res) => {
        if (!cancelled) setList(res);
      })
      .catch((e) => {
        if (!cancelled) toast.error(normalizeError(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, repoRoot]);

  const switchTo = async (target: string, create: boolean) => {
    setBusy(true);
    try {
      await native.gitCheckoutBranch(repoRoot, target, create);
      setOpen(false);
      setQuery("");
      onChanged();
    } catch (e) {
      toast.error(normalizeError(e));
    } finally {
      setBusy(false);
    }
  };

  const branches = list?.local ?? [];
  const current = list?.current ?? (detached ? null : branch);
  const trimmed = query.trim();
  const exists = branches.includes(trimmed);
  const showCreate = trimmed.length > 0 && !exists;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={detached ? "Detached HEAD — switch branch" : "Switch branch"}
          className="flex shrink-0 items-center gap-1 rounded-md px-1 text-[10.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={GitBranchIcon} size={11} strokeWidth={1.75} />
          <span className="max-w-32 truncate">
            {detached ? "detached" : branch}
          </span>
          {ahead > 0 ? <span>↑{ahead}</span> : null}
          {behind > 0 ? <span>↓{behind}</span> : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-64 p-0">
        <Command>
          <CommandInput
            placeholder="Switch or create branch…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-6 text-[12px] text-muted-foreground">
                <Spinner className="size-3.5" />
                Loading branches…
              </div>
            ) : (
              <>
                <CommandEmpty>No matching branch.</CommandEmpty>
                {branches.length > 0 ? (
                  <CommandGroup heading="Branches">
                    {branches.map((b) => {
                      const isCurrent = b === current;
                      return (
                        <CommandItem
                          key={b}
                          value={b}
                          disabled={busy || isCurrent}
                          onSelect={() => {
                            if (!isCurrent) void switchTo(b, false);
                          }}
                          className="text-[12px]"
                        >
                          <HugeiconsIcon
                            icon={isCurrent ? Tick02Icon : GitBranchIcon}
                            size={13}
                            strokeWidth={1.85}
                            className={cn(
                              "shrink-0",
                              isCurrent
                                ? "text-foreground"
                                : "text-muted-foreground",
                            )}
                          />
                          <span className="truncate">{b}</span>
                          {isCurrent ? (
                            <span className="ml-auto text-[10px] text-muted-foreground">
                              current
                            </span>
                          ) : null}
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                ) : null}
                {showCreate ? (
                  <CommandGroup heading="Create">
                    <CommandItem
                      value={`__create__${trimmed}`}
                      disabled={busy}
                      onSelect={() => void switchTo(trimmed, true)}
                      className="text-[12px]"
                    >
                      <HugeiconsIcon
                        icon={Add01Icon}
                        size={13}
                        strokeWidth={1.95}
                        className="shrink-0 text-muted-foreground"
                      />
                      <span className="truncate">
                        Create branch{" "}
                        <span className="font-medium text-foreground">
                          {trimmed}
                        </span>
                      </span>
                    </CommandItem>
                  </CommandGroup>
                ) : null}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
