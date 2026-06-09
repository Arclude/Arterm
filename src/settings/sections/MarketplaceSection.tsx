import {
  ArrowReloadHorizontalIcon,
  CheckmarkCircle02Icon,
  Download04Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DEFAULT_REGISTRY_URL,
  fetchRegistry,
  getEffectiveRegistryUrl,
  getRegistryUrl,
  installFromFile,
  installFromRegistry,
  installFromUrl,
  isUpdateAvailable,
  type RegistryEntry,
  setRegistryUrl,
  useExtensionsStore,
} from "@/modules/extensions";

type Status =
  | { kind: "available" }
  | { kind: "installed" }
  | { kind: "update"; from: string };

export function MarketplaceSection() {
  const installed = useExtensionsStore((s) => s.extensions);
  const fileRef = useRef<HTMLInputElement>(null);

  const [entries, setEntries] = useState<RegistryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [registryUrl, setRegistryUrlInput] = useState("");
  const [urlInput, setUrlInput] = useState("");
  const [installError, setInstallError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async (url?: string) => {
    setLoading(true);
    setError(null);
    try {
      setEntries(await fetchRegistry(url));
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load registry");
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      setRegistryUrlInput((await getRegistryUrl()) ?? "");
      await refresh(await getEffectiveRegistryUrl());
    })();
  }, [refresh]);

  const statusOf = useCallback(
    (entry: RegistryEntry): Status => {
      const match = installed.find((e) => e.manifest?.id === entry.id);
      if (!match?.manifest) return { kind: "available" };
      if (isUpdateAvailable(match.manifest.version, entry.version)) {
        return { kind: "update", from: match.manifest.version };
      }
      return { kind: "installed" };
    },
    [installed],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) =>
      [e.name, e.description, e.author, ...(e.tags ?? [])]
        .filter(Boolean)
        .some((s) => s?.toLowerCase().includes(q)),
    );
  }, [entries, query]);

  const runInstall = async (label: string, fn: () => Promise<unknown>) => {
    setBusyId(label);
    setInstallError(null);
    try {
      await fn();
    } catch (e) {
      setInstallError(e instanceof Error ? e.message : "install failed");
    } finally {
      setBusyId(null);
    }
  };

  const saveRegistry = async () => {
    await setRegistryUrl(registryUrl || null);
    await refresh(await getEffectiveRegistryUrl());
  };
  const resetRegistry = async () => {
    setRegistryUrlInput("");
    await setRegistryUrl(null);
    await refresh(DEFAULT_REGISTRY_URL);
  };

  return (
    <div className="flex flex-col gap-5">
      <p className="text-[11.5px] text-muted-foreground">
        Browse and install theme and snippet packages from a GitHub registry.
        These are declarative — no code runs, so installing is safe.
      </p>

      {/* Install from URL / file */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-1.5">
          <Input
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="Install from URL (raw manifest URL or owner/repo)"
            className="h-8 text-[12px]"
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8 shrink-0 px-2 text-[11px]"
            disabled={!urlInput.trim() || busyId === "url"}
            onClick={() =>
              void runInstall("url", () => installFromUrl(urlInput)).then(() =>
                setUrlInput(""),
              )
            }
          >
            Install
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 shrink-0 px-2 text-[11px]"
            onClick={() => fileRef.current?.click()}
          >
            From file
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".artex-ext,.json,application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void runInstall("file", () => installFromFile(f));
            }}
          />
        </div>
        {installError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11.5px] text-destructive">
            {installError}
          </div>
        ) : null}
      </div>

      {/* Registry source + search */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-1.5">
          <Input
            value={registryUrl}
            onChange={(e) => setRegistryUrlInput(e.target.value)}
            placeholder={DEFAULT_REGISTRY_URL}
            className="h-8 text-[11px]"
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8 shrink-0 px-2 text-[11px]"
            onClick={() => void saveRegistry()}
          >
            Save
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 shrink-0 px-2 text-[11px]"
            onClick={() => void resetRegistry()}
          >
            Reset
          </Button>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1">
            <HugeiconsIcon
              icon={Search01Icon}
              size={13}
              strokeWidth={1.75}
              className="-translate-y-1/2 absolute top-1/2 left-2 text-muted-foreground"
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search extensions…"
              className="h-8 pl-7 text-[12px]"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8 shrink-0 gap-1.5 px-2 text-[11px]"
            disabled={loading}
            onClick={() => void refresh()}
          >
            <HugeiconsIcon
              icon={ArrowReloadHorizontalIcon}
              size={11}
              strokeWidth={2}
            />
            Refresh
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11.5px] text-destructive">
          {error}
        </div>
      ) : null}

      {!loading && !error && filtered.length === 0 ? (
        <div className="rounded-lg border border-border/60 px-3 py-6 text-center text-[12px] text-muted-foreground">
          {entries.length === 0
            ? "No registry found. Set a registry URL above (a GitHub raw index.json)."
            : "No extensions match your search."}
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        {filtered.map((entry) => {
          const status = statusOf(entry);
          const busy = busyId === entry.id;
          return (
            <div
              key={entry.id}
              className="flex items-start gap-3 rounded-lg border border-border/60 p-3"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[12.5px] font-medium">
                    {entry.name}
                  </span>
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    v{entry.version}
                  </span>
                  {entry.author ? (
                    <span className="shrink-0 text-[10.5px] text-muted-foreground">
                      by {entry.author}
                    </span>
                  ) : null}
                </div>
                {entry.description ? (
                  <span className="text-[11px] text-muted-foreground">
                    {entry.description}
                  </span>
                ) : null}
                {entry.tags && entry.tags.length > 0 ? (
                  <div className="mt-1 flex flex-wrap gap-1.5 text-[10.5px] text-muted-foreground">
                    {entry.tags.map((t) => (
                      <span key={t} className="rounded bg-muted px-1.5 py-0.5">
                        {t}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="shrink-0">
                {status.kind === "installed" ? (
                  <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <HugeiconsIcon
                      icon={CheckmarkCircle02Icon}
                      size={13}
                      strokeWidth={1.75}
                    />
                    Installed
                  </span>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1.5 px-2 text-[11px]"
                    disabled={busy}
                    onClick={() =>
                      void runInstall(entry.id, () =>
                        installFromRegistry(entry),
                      )
                    }
                  >
                    <HugeiconsIcon
                      icon={Download04Icon}
                      size={11}
                      strokeWidth={2}
                    />
                    {status.kind === "update" ? "Update" : "Install"}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
