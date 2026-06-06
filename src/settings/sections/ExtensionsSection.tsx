import {
  ArrowReloadHorizontalIcon,
  Delete02Icon,
  FolderOpenIcon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  installFromFile,
  installSampleExtension,
  loadExtensions,
  openExtensionsFolder,
  toggleExtension,
  uninstallExtension,
  useExtensionsStore,
} from "@/modules/extensions";
import { SectionHeader } from "../components/SectionHeader";
import { MarketplaceSection } from "./MarketplaceSection";

export function ExtensionsSection() {
  const extensions = useExtensionsStore((s) => s.extensions);
  const loaded = useExtensionsStore((s) => s.loaded);
  const fileRef = useRef<HTMLInputElement>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [view, setView] = useState<"installed" | "browse">("installed");

  // The settings window is a separate webview, so load extensions here too.
  useEffect(() => {
    void loadExtensions();
  }, []);

  return (
    <div className="flex flex-col gap-5">
      <SectionHeader
        title="Extensions"
        description="Declarative packages that add themes and snippets. No code runs — installing one is safe."
      />

      <div className="flex w-fit items-center gap-0.5 rounded-lg bg-muted/40 p-0.5">
        <button
          type="button"
          onClick={() => setView("installed")}
          className={cn(
            "h-7 rounded-md px-3 text-[11.5px] transition-colors",
            view === "installed"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          Installed
        </button>
        <button
          type="button"
          onClick={() => setView("browse")}
          className={cn(
            "h-7 rounded-md px-3 text-[11.5px] transition-colors",
            view === "browse"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          Browse
        </button>
      </div>

      {view === "browse" ? (
        <MarketplaceSection />
      ) : (
        <>
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2 text-[11px]"
              onClick={() => void installSampleExtension()}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={11} strokeWidth={2} />
              Add sample
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2 text-[11px]"
              onClick={() => void openExtensionsFolder()}
            >
              <HugeiconsIcon icon={FolderOpenIcon} size={11} strokeWidth={2} />
              Open folder
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2 text-[11px]"
              onClick={() => fileRef.current?.click()}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={11} strokeWidth={2} />
              From file
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2 text-[11px]"
              onClick={() => void loadExtensions()}
            >
              <HugeiconsIcon
                icon={ArrowReloadHorizontalIcon}
                size={11}
                strokeWidth={2}
              />
              Reload
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".artex-ext,.json,application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                setInstallError(null);
                void installFromFile(f).catch((err) =>
                  setInstallError(
                    err instanceof Error ? err.message : "install failed",
                  ),
                );
              }}
            />
          </div>
          {installError ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11.5px] text-destructive">
              {installError}
            </div>
          ) : null}

          {loaded && extensions.length === 0 ? (
            <div className="rounded-lg border border-border/60 px-3 py-6 text-center text-[12px] text-muted-foreground">
              No extensions installed. Click{" "}
              <span className="font-medium">Add sample</span> to try one, or
              drop a package folder into the extensions directory.
            </div>
          ) : null}

          <div className="flex flex-col gap-2">
            {extensions.map((ext) => {
              const m = ext.manifest;
              const key = ext.folder;
              if (!m) {
                return (
                  <div
                    key={key}
                    className="rounded-lg border border-destructive/40 bg-destructive/5 p-3"
                  >
                    <div className="text-[12.5px] font-medium">
                      {ext.folder}
                    </div>
                    <div className="text-[11px] text-destructive">
                      Failed to load: {ext.error ?? "unknown error"}
                    </div>
                  </div>
                );
              }
              return (
                <div
                  key={key}
                  className="flex items-start gap-3 rounded-lg border border-border/60 p-3"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[12.5px] font-medium">
                        {m.name}
                      </span>
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        v{m.version}
                      </span>
                      {m.author ? (
                        <span className="shrink-0 text-[10.5px] text-muted-foreground">
                          by {m.author}
                        </span>
                      ) : null}
                    </div>
                    {m.description ? (
                      <span className="text-[11px] text-muted-foreground">
                        {m.description}
                      </span>
                    ) : null}
                    <div className="mt-1 flex flex-wrap gap-1.5 text-[10.5px] text-muted-foreground">
                      {ext.themeIds.length > 0 ? (
                        <span className="rounded bg-muted px-1.5 py-0.5">
                          {ext.themeIds.length} theme
                          {ext.themeIds.length > 1 ? "s" : ""}
                        </span>
                      ) : null}
                      {ext.snippetHandles.length > 0 ? (
                        <span className="rounded bg-muted px-1.5 py-0.5">
                          {ext.snippetHandles.length} snippet
                          {ext.snippetHandles.length > 1 ? "s" : ""}
                        </span>
                      ) : null}
                      {(m.permissions ?? []).map((p) => (
                        <span
                          key={p}
                          className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-600 dark:text-amber-400"
                        >
                          {p}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Switch
                      checked={ext.enabled}
                      onCheckedChange={(v) => void toggleExtension(m.id, v)}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      aria-label={`Uninstall ${m.name}`}
                      onClick={() => void uninstallExtension(ext.folder)}
                    >
                      <HugeiconsIcon
                        icon={Delete02Icon}
                        size={13}
                        strokeWidth={1.75}
                      />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
