import { ArrowReloadHorizontalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { DEFAULT_LSP_SERVERS } from "@/modules/lsp/config";
import {
  installServer,
  listInstalled,
  uninstallServer,
} from "@/modules/lsp/install";
import {
  assetFor,
  INSTALL_REGISTRY,
  type InstallEntry,
} from "@/modules/lsp/installRegistry";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  type LspServerConfig,
  setLspEnabled,
  setLspServers,
} from "@/modules/settings/store";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";

type DefaultServer = (typeof DEFAULT_LSP_SERVERS)[string];

function effectiveConfig(
  def: DefaultServer,
  override: LspServerConfig | undefined,
): Required<LspServerConfig> {
  return {
    command: override?.command ?? def.command,
    args: override?.args ?? def.args,
    enabled: override?.enabled ?? true,
  };
}

export function LanguageServersSection() {
  const lspEnabled = usePreferencesStore((s) => s.lspEnabled);
  const lspServers = usePreferencesStore((s) => s.lspServers);

  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const refreshInstalled = () => {
    void listInstalled()
      .then((list) => setInstalled(new Set(list.map((s) => s.serverId))))
      .catch((e) => console.warn("lsp: list installed failed:", e));
  };
  useEffect(refreshInstalled, []);

  const langIds = Object.keys(DEFAULT_LSP_SERVERS);

  const writeConfig = (langId: string, next: LspServerConfig) => {
    void setLspServers({ ...lspServers, [langId]: next });
  };

  const resetConfig = (langId: string) => {
    const next = { ...lspServers };
    delete next[langId];
    void setLspServers(next);
  };

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Language Servers"
        description="Language servers add code intelligence: completion, hover, go-to-definition, and diagnostics."
      />

      <SettingRow
        title="Enable language servers"
        description="Start a language server per file type to power editor intelligence."
      >
        <Switch
          checked={lspEnabled}
          onCheckedChange={(v) => void setLspEnabled(v)}
        />
      </SettingRow>

      <div
        className={cn(
          "flex flex-col gap-2",
          !lspEnabled && "pointer-events-none opacity-50",
        )}
        aria-disabled={!lspEnabled}
      >
        <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
          Servers
        </span>
        {langIds.map((langId) => {
          const def = DEFAULT_LSP_SERVERS[langId];
          const override = lspServers[langId];
          const config = effectiveConfig(def, override);
          const entry = INSTALL_REGISTRY[langId];
          const installable = entry ? assetFor(entry) != null : false;
          return (
            <ServerRow
              key={langId}
              langId={langId}
              label={def.label}
              config={config}
              isOverridden={override !== undefined}
              disabled={!lspEnabled}
              entry={installable ? entry : undefined}
              installed={installed.has(langId)}
              onInstalledChange={refreshInstalled}
              onChange={(next) => writeConfig(langId, next)}
              onReset={() => resetConfig(langId)}
            />
          );
        })}
      </div>
    </div>
  );
}

function ServerRow({
  langId,
  label,
  config,
  isOverridden,
  disabled,
  entry,
  installed,
  onInstalledChange,
  onChange,
  onReset,
}: {
  langId: string;
  label: string;
  config: Required<LspServerConfig>;
  isOverridden: boolean;
  disabled: boolean;
  entry?: InstallEntry;
  installed: boolean;
  onInstalledChange: () => void;
  onChange: (next: LspServerConfig) => void;
  onReset: () => void;
}) {
  const argsText = config.args.join(" ");
  const [commandDraft, setCommandDraft] = useState(config.command);
  const [argsDraft, setArgsDraft] = useState(argsText);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);

  const handleInstall = async () => {
    if (!entry) return;
    setBusy(true);
    setProgress(0);
    try {
      await installServer(entry, (p) => {
        setProgress(
          p.total ? Math.round((p.downloaded / p.total) * 100) : null,
        );
      });
      onInstalledChange();
    } catch (e) {
      console.error("lsp: install failed:", e);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const handleUninstall = async () => {
    if (!entry) return;
    setBusy(true);
    try {
      await uninstallServer(entry.id);
      onInstalledChange();
    } catch (e) {
      console.error("lsp: uninstall failed:", e);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    setCommandDraft(config.command);
  }, [config.command]);

  useEffect(() => {
    setArgsDraft(argsText);
  }, [argsText]);

  const commit = (command: string, args: string) => {
    const parsedArgs = args.trim().length > 0 ? args.trim().split(/\s+/) : [];
    const next: LspServerConfig = {
      command: command.trim(),
      args: parsedArgs,
      enabled: config.enabled,
    };
    if (
      next.command === config.command &&
      next.args.join(" ") === config.args.join(" ")
    ) {
      return;
    }
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-2 text-[12.5px] font-medium">
            {label}
            <code className="rounded bg-muted/50 px-1 py-0.5 font-mono text-[9.5px] tracking-wide text-muted-foreground">
              {langId}
            </code>
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {entry ? (
            <Button
              size="sm"
              variant={installed ? "ghost" : "secondary"}
              className="h-7 px-2 text-[11px]"
              disabled={busy || disabled}
              onClick={installed ? handleUninstall : handleInstall}
              title={
                installed
                  ? "Remove the managed binary"
                  : `Download ${entry.label}`
              }
            >
              {busy
                ? progress != null
                  ? `${progress}%`
                  : "…"
                : installed
                  ? "Uninstall"
                  : "Install"}
            </Button>
          ) : null}
          {isOverridden ? (
            <Button
              size="icon"
              variant="ghost"
              className="size-7 text-muted-foreground hover:text-foreground"
              disabled={disabled}
              onClick={onReset}
              title="Reset to default"
            >
              <HugeiconsIcon
                icon={ArrowReloadHorizontalIcon}
                size={12}
                strokeWidth={1.75}
              />
            </Button>
          ) : null}
          <Switch
            size="sm"
            checked={config.enabled}
            disabled={disabled}
            onCheckedChange={(v) =>
              onChange({
                command: config.command,
                args: config.args,
                enabled: v,
              })
            }
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Input
          value={commandDraft}
          disabled={disabled}
          placeholder="command"
          onChange={(e) => setCommandDraft(e.target.value)}
          onBlur={() => commit(commandDraft, argsDraft)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          className="h-8 w-40 shrink-0 rounded-md border border-border bg-background px-2.5 font-mono text-[11.5px] focus-visible:ring-0 focus-visible:border-foreground/40"
        />
        <Input
          value={argsDraft}
          disabled={disabled}
          placeholder="arguments"
          onChange={(e) => setArgsDraft(e.target.value)}
          onBlur={() => commit(commandDraft, argsDraft)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          className="h-8 flex-1 rounded-md border border-border bg-background px-2.5 font-mono text-[11.5px] focus-visible:ring-0 focus-visible:border-foreground/40"
        />
      </div>
    </div>
  );
}
