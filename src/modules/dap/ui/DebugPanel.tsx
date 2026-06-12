import {
  ArrowDown01Icon,
  ArrowMoveDownRightIcon,
  ArrowMoveUpRightIcon,
  ArrowRight01Icon,
  ArrowTurnForwardIcon,
  BugIcon,
  PauseIcon,
  PlayIcon,
  ReloadIcon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import type { Scope, StackFrame, Variable } from "../protocol";
import { debugController } from "../session";
import { useDebugStore } from "../store";

type Props = {
  /** Active editor file — the program to debug when it's a .py. */
  activeFilePath: string | null;
  /** Workspace root, used as the debuggee cwd. */
  cwd: string | null;
};

const MAX_VARIABLE_DEPTH = 20;

const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;
const dirname = (p: string) => p.replace(/[\\/][^\\/]*$/, "");

export function DebugPanel({ activeFilePath, cwd }: Props) {
  const status = useDebugStore((s) => s.status);
  const programName = useDebugStore((s) => s.programName);

  const isActive = status !== "inactive" && status !== "terminated";
  const isStopped = status === "stopped";
  const isRunning = status === "running" || status === "starting";

  const canDebugFile =
    !!activeFilePath && activeFilePath.toLowerCase().endsWith(".py");

  const start = () => {
    if (!activeFilePath) return;
    void debugController.start({
      program: activeFilePath,
      cwd: cwd ?? dirname(activeFilePath),
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col text-xs">
      <div className="flex items-center gap-1.5 border-b border-border/60 px-2 py-1.5">
        <HugeiconsIcon
          icon={BugIcon}
          size={14}
          className="shrink-0 text-muted-foreground"
        />
        <span className="font-medium text-foreground/90">Run and Debug</span>
        <span className="ml-auto truncate text-[10px] text-muted-foreground">
          {isActive ? programName : ""}
        </span>
      </div>

      <Toolbar
        isActive={isActive}
        isStopped={isStopped}
        isRunning={isRunning}
        canDebugFile={canDebugFile}
        onStart={start}
      />

      {!isActive && !canDebugFile ? (
        <div className="px-3 py-3 text-[11px] leading-relaxed text-muted-foreground">
          Open a Python (<code>.py</code>) file and press{" "}
          <HugeiconsIcon
            icon={PlayIcon}
            size={11}
            className="inline align-text-bottom"
          />{" "}
          to start debugging. Requires{" "}
          <code>python -m pip install debugpy</code>.
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isActive ? <CallStackSection /> : null}
        {isStopped ? <VariablesSection /> : null}
        <BreakpointsSection />
        {/* Keep output visible after the session ends so launch errors and the
            final exit code stay readable until the next run. */}
        {status !== "inactive" ? <OutputSection /> : null}
      </div>
    </div>
  );
}

function Toolbar({
  isActive,
  isStopped,
  isRunning,
  canDebugFile,
  onStart,
}: {
  isActive: boolean;
  isStopped: boolean;
  isRunning: boolean;
  canDebugFile: boolean;
  onStart: () => void;
}) {
  return (
    <div className="flex items-center gap-0.5 border-b border-border/60 px-1.5 py-1">
      {!isActive ? (
        <IconButton
          icon={PlayIcon}
          label="Start debugging"
          disabled={!canDebugFile}
          onClick={onStart}
          tone="run"
        />
      ) : (
        <>
          <IconButton
            icon={PlayIcon}
            label="Continue"
            disabled={!isStopped}
            onClick={() => debugController.continue()}
            tone="run"
          />
          <IconButton
            icon={PauseIcon}
            label="Pause"
            disabled={!isRunning}
            onClick={() => debugController.pause()}
          />
          <IconButton
            icon={ArrowTurnForwardIcon}
            label="Step over"
            disabled={!isStopped}
            onClick={() => debugController.stepOver()}
          />
          <IconButton
            icon={ArrowMoveDownRightIcon}
            label="Step into"
            disabled={!isStopped}
            onClick={() => debugController.stepIn()}
          />
          <IconButton
            icon={ArrowMoveUpRightIcon}
            label="Step out"
            disabled={!isStopped}
            onClick={() => debugController.stepOut()}
          />
          <IconButton
            icon={ReloadIcon}
            label="Restart"
            disabled={!canDebugFile}
            onClick={onStart}
          />
          <IconButton
            icon={StopIcon}
            label="Stop"
            onClick={() => void debugController.stop()}
            tone="stop"
          />
        </>
      )}
    </div>
  );
}

function IconButton({
  icon,
  label,
  onClick,
  disabled,
  tone,
}: {
  icon: Parameters<typeof HugeiconsIcon>[0]["icon"];
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: "run" | "stop";
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-md outline-none transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-35",
        "enabled:hover:bg-foreground/[0.06]",
        tone === "run"
          ? "text-emerald-500"
          : tone === "stop"
            ? "text-red-500"
            : "text-foreground/80",
      )}
    >
      <HugeiconsIcon icon={icon} size={15} strokeWidth={1.9} />
    </button>
  );
}

function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="border-b border-border/40">
      <div className="flex items-center gap-2 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/80">
        <span>{title}</span>
        {action ? <span className="ml-auto normal-case">{action}</span> : null}
      </div>
      <div className="pb-1">{children}</div>
    </div>
  );
}

function CallStackSection() {
  const frames = useDebugStore((s) => s.frames);
  const activeFrameId = useDebugStore((s) => s.activeFrameId);

  return (
    <Section title="Call Stack">
      {frames.length === 0 ? (
        <Empty>Not paused</Empty>
      ) : (
        frames.map((f: StackFrame) => (
          <button
            key={f.id}
            type="button"
            onClick={() => void debugController.selectFrame(f.id)}
            className={cn(
              "flex w-full items-baseline gap-2 px-3 py-0.5 text-left hover:bg-foreground/[0.04]",
              f.id === activeFrameId && "bg-foreground/[0.06]",
            )}
          >
            <span className="truncate text-foreground/90">{f.name}</span>
            <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
              {f.source?.name ?? basename(f.source?.path ?? "")}:{f.line}
            </span>
          </button>
        ))
      )}
    </Section>
  );
}

function VariablesSection() {
  const scopes = useDebugStore((s) => s.scopes);
  return (
    <Section title="Variables">
      {scopes.length === 0 ? (
        <Empty>No variables</Empty>
      ) : (
        scopes.map((scope: Scope) => (
          <ScopeNode key={scope.variablesReference} scope={scope} />
        ))
      )}
    </Section>
  );
}

function ScopeNode({ scope }: { scope: Scope }) {
  const [open, setOpen] = useState(!scope.expensive);
  return (
    <div>
      <Twisty
        open={open}
        depth={0}
        onToggle={() => {
          if (!open)
            void debugController.loadVariables(scope.variablesReference);
          setOpen((v) => !v);
        }}
        label={
          <span className="font-medium text-foreground/85">{scope.name}</span>
        }
      />
      {open ? (
        <VariableChildren reference={scope.variablesReference} depth={1} />
      ) : null}
    </div>
  );
}

function VariableChildren({
  reference,
  depth,
}: {
  reference: number;
  depth: number;
}) {
  const vars = useDebugStore((s) => s.variablesByRef[reference]);
  if (!vars) return <Empty depth={depth}>…</Empty>;
  if (vars.length === 0) return null;
  return (
    <>
      {vars.map((v, i) => (
        <VariableNode key={`${v.name}-${i}`} variable={v} depth={depth} />
      ))}
    </>
  );
}

function VariableNode({
  variable,
  depth,
}: {
  variable: Variable;
  depth: number;
}) {
  const [open, setOpen] = useState(false);
  // Guard against pathologically deep / cyclic variable trees.
  const expandable =
    variable.variablesReference > 0 && depth < MAX_VARIABLE_DEPTH;
  return (
    <div>
      <Twisty
        open={open}
        depth={depth}
        hasChildren={expandable}
        onToggle={() => {
          if (!expandable) return;
          if (!open)
            void debugController.loadVariables(variable.variablesReference);
          setOpen((v) => !v);
        }}
        label={
          <span className="truncate">
            <span className="text-sky-400">{variable.name}</span>
            <span className="text-muted-foreground">: </span>
            <span className="text-foreground/80">{variable.value}</span>
          </span>
        }
      />
      {open && expandable ? (
        <VariableChildren
          reference={variable.variablesReference}
          depth={depth + 1}
        />
      ) : null}
    </div>
  );
}

function Twisty({
  open,
  depth,
  hasChildren = true,
  onToggle,
  label,
}: {
  open: boolean;
  depth: number;
  hasChildren?: boolean;
  onToggle: () => void;
  label: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{ paddingLeft: 8 + depth * 12 }}
      className="flex w-full items-center gap-1 py-0.5 pr-2 text-left hover:bg-foreground/[0.04]"
    >
      <span className="flex h-3 w-3 shrink-0 items-center justify-center text-muted-foreground">
        {hasChildren ? (
          <HugeiconsIcon
            icon={open ? ArrowDown01Icon : ArrowRight01Icon}
            size={11}
          />
        ) : null}
      </span>
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

function BreakpointsSection() {
  const breakpoints = useDebugStore((s) => s.breakpoints);
  const entries = Object.entries(breakpoints).flatMap(([path, bps]) =>
    bps.map((b) => ({ path, line: b.line, verified: b.verified })),
  );

  return (
    <Section title="Breakpoints">
      {entries.length === 0 ? (
        <Empty>No breakpoints</Empty>
      ) : (
        entries.map((e) => (
          <button
            key={`${e.path}:${e.line}`}
            type="button"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent("arterm:lsp-goto", {
                  detail: { path: e.path, line: e.line - 1, character: 0 },
                }),
              )
            }
            className="flex w-full items-center gap-2 px-3 py-0.5 text-left hover:bg-foreground/[0.04]"
          >
            <span
              className={cn(
                "shrink-0 text-[10px]",
                e.verified ? "text-red-500" : "text-red-500/45",
              )}
            >
              ●
            </span>
            <span className="truncate text-foreground/85">
              {basename(e.path)}
            </span>
            <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
              {e.line}
            </span>
          </button>
        ))
      )}
    </Section>
  );
}

function OutputSection() {
  const output = useDebugStore((s) => s.output);
  const copyAll = () => {
    void navigator.clipboard.writeText(output.map((l) => l.text).join(""));
  };
  return (
    <Section
      title="Output"
      action={
        output.length > 0 ? (
          <button
            type="button"
            onClick={copyAll}
            className="rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
          >
            Copy
          </button>
        ) : null
      }
    >
      {output.length === 0 ? (
        <Empty>No output</Empty>
      ) : (
        <pre className="max-h-48 select-text overflow-y-auto whitespace-pre-wrap px-3 py-1 font-mono text-[11px] leading-relaxed">
          {output.map((l, i) => (
            <span
              key={i}
              className={cn(
                l.category === "stderr" && "text-red-400",
                l.category === "stdout" && "text-foreground/80",
                l.category === "console" && "text-muted-foreground",
              )}
            >
              {l.text}
            </span>
          ))}
        </pre>
      )}
    </Section>
  );
}

function Empty({
  children,
  depth = 0,
}: {
  children: React.ReactNode;
  depth?: number;
}) {
  return (
    <div
      style={{ paddingLeft: 12 + depth * 12 }}
      className="py-0.5 pr-2 text-[11px] italic text-muted-foreground/70"
    >
      {children}
    </div>
  );
}
