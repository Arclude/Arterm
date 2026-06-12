import { DapClient } from "./client";
import type {
  Breakpoint,
  Capabilities,
  ContinuedEvent,
  OutputEvent,
  PythonLaunchConfig,
  Scope,
  StackFrame,
  StoppedEvent,
  Thread,
  Variable,
} from "./protocol";
import { useDebugStore } from "./store";

// Imperative controller that owns the live DapClient and drives the
// initialize → launch → setBreakpoints → configurationDone handshake, mapping
// DAP events onto the reactive store. One session at a time (MVP).

export type StartDebugConfig = {
  /** Absolute path to the .py entry file. */
  program: string;
  /** Working directory; defaults to the program's folder. */
  cwd: string;
  /** Python interpreter; defaults to "python". */
  pythonPath?: string;
  stopOnEntry?: boolean;
  args?: string[];
};

const store = () => useDebugStore.getState();

class DebugController {
  private client: DapClient | null = null;
  private caps: Capabilities = {};
  private activeThreadId: number | null = null;

  get isActive(): boolean {
    return this.client !== null && !this.client.isDisposed;
  }

  async start(config: StartDebugConfig): Promise<void> {
    if (this.isActive) await this.stop();

    const programName = config.program.split(/[\\/]/).pop() ?? config.program;
    store().reset(programName);
    store().setStatus("starting");

    const python = config.pythonPath?.trim() || "python";
    let client: DapClient;
    try {
      client = await DapClient.create({
        command: python,
        args: ["-m", "debugpy.adapter"],
        cwd: config.cwd,
      });
    } catch (e) {
      this.fail(
        `Failed to start debugpy (${python} -m debugpy.adapter): ${
          e instanceof Error ? e.message : String(e)
        }. Install it with: ${python} -m pip install debugpy`,
      );
      return;
    }
    this.client = client;

    this.wireEvents(client);

    try {
      const caps = await client.request<Capabilities>("initialize", {
        clientID: "arterm",
        clientName: "Arterm",
        adapterID: "python",
        locale: "en",
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: "path",
        supportsRunInTerminalRequest: false,
        supportsStartDebuggingRequest: false,
        supportsVariableType: true,
      });
      this.caps = caps ?? {};
    } catch (e) {
      this.fail(`initialize failed: ${msg(e)}`);
      return;
    }

    // The adapter emits `initialized` once it's ready for breakpoint config.
    // Register before sending launch so we never miss it.
    client.onEvent("initialized", () => {
      void this.configure();
    });

    const launchConfig: PythonLaunchConfig = {
      request: "launch",
      type: "python",
      program: config.program,
      cwd: config.cwd,
      console: "internalConsole",
      stopOnEntry: config.stopOnEntry ?? false,
      justMyCode: true,
      ...(config.args ? { args: config.args } : {}),
    };
    // launch resolves only after configurationDone — fire and report failures.
    client.request("launch", launchConfig).catch((e) => {
      this.appendErr(`launch failed: ${msg(e)}`);
      void this.stop();
    });

    store().setStatus("running");
  }

  private wireEvents(client: DapClient): void {
    client.onEvent("output", (b) => {
      const ev = b as OutputEvent;
      store().appendOutput({
        category: ev.category ?? "console",
        text: ev.output,
      });
    });

    client.onEvent("stopped", (b) => {
      void this.onStopped(b as StoppedEvent);
    });

    client.onEvent("continued", (b) => {
      const ev = b as ContinuedEvent;
      this.activeThreadId = ev.threadId;
      store().setRunning();
    });

    client.onEvent("terminated", () => {
      this.appendOut("Debug session terminated.");
      void this.cleanup("terminated");
    });

    client.onEvent("exited", (b) => {
      const code = (b as { exitCode?: number })?.exitCode ?? 0;
      this.appendOut(`Process exited with code ${code}.`);
    });
  }

  private async configure(): Promise<void> {
    if (!this.client) return;
    const total = Object.values(store().breakpoints).reduce(
      (n, a) => n + a.length,
      0,
    );
    this.appendOut(`Configuring ${total} breakpoint(s)…`);
    await this.syncAllBreakpoints();
    try {
      await this.client.request("setExceptionBreakpoints", {
        filters: [],
      });
    } catch {
      // optional — not all configs support it
    }
    if (this.caps.supportsConfigurationDoneRequest) {
      try {
        await this.client.request("configurationDone");
      } catch (e) {
        this.appendErr(`configurationDone failed: ${msg(e)}`);
      }
    }
  }

  private async onStopped(ev: StoppedEvent): Promise<void> {
    if (!this.client) return;
    const threadId = ev.threadId ?? this.activeThreadId ?? 1;
    this.activeThreadId = threadId;

    try {
      const threadsRes = await this.client.request<{ threads: Thread[] }>(
        "threads",
      );
      store().setThreads(threadsRes?.threads ?? []);
    } catch {
      // non-fatal
    }

    let frames: StackFrame[] = [];
    try {
      const st = await this.client.request<{ stackFrames: StackFrame[] }>(
        "stackTrace",
        { threadId, startFrame: 0, levels: 20 },
      );
      frames = st?.stackFrames ?? [];
    } catch (e) {
      this.appendErr(`stackTrace failed: ${msg(e)}`);
    }

    const top = frames[0];
    const location =
      top?.source?.path != null
        ? { path: top.source.path, line: top.line }
        : null;
    store().setStopped(threadId, frames, location);

    // Open the paused file so its execution-line highlight (and gutter) show.
    // The shared "arterm:lsp-goto" event expects a 0-based line, so convert from
    // DAP's 1-based line here (the listener adds 1 back for CodeMirror).
    if (location) {
      window.dispatchEvent(
        new CustomEvent("arterm:lsp-goto", {
          detail: {
            path: location.path,
            line: location.line - 1,
            character: 0,
          },
        }),
      );
    }

    if (top) await this.selectFrame(top.id);
  }

  async selectFrame(frameId: number): Promise<void> {
    if (!this.client) return;
    try {
      const res = await this.client.request<{ scopes: Scope[] }>("scopes", {
        frameId,
      });
      store().setActiveFrame(frameId, res?.scopes ?? []);
    } catch (e) {
      this.appendErr(`scopes failed: ${msg(e)}`);
    }
  }

  async loadVariables(reference: number): Promise<void> {
    if (!this.client) return;
    try {
      const res = await this.client.request<{ variables: Variable[] }>(
        "variables",
        { variablesReference: reference },
      );
      store().setVariables(reference, res?.variables ?? []);
    } catch (e) {
      this.appendErr(`variables failed: ${msg(e)}`);
    }
  }

  // --- execution control ---
  continue(): void {
    this.exec("continue");
  }
  pause(): void {
    if (!this.client || this.activeThreadId == null) return;
    void this.client
      .request("pause", { threadId: this.activeThreadId })
      .catch((e) => this.appendErr(`pause failed: ${msg(e)}`));
  }
  stepOver(): void {
    this.exec("next");
  }
  stepIn(): void {
    this.exec("stepIn");
  }
  stepOut(): void {
    this.exec("stepOut");
  }

  private exec(command: "continue" | "next" | "stepIn" | "stepOut"): void {
    if (!this.client || this.activeThreadId == null) return;
    store().setRunning();
    void this.client
      .request(command, { threadId: this.activeThreadId })
      .catch((e) => this.appendErr(`${command} failed: ${msg(e)}`));
  }

  async stop(): Promise<void> {
    if (!this.client) {
      store().setStatus("inactive");
      return;
    }
    try {
      await this.client.request("disconnect", { terminateDebuggee: true });
    } catch {
      // adapter may already be gone
    }
    await this.cleanup("inactive");
  }

  // --- breakpoints ---
  toggleBreakpoint(path: string, line: number): void {
    store().toggleBreakpoint(path, line);
    if (this.isActive) void this.syncBreakpoints(path);
  }

  private async syncAllBreakpoints(): Promise<void> {
    const all = store().breakpoints;
    for (const path of Object.keys(all)) {
      await this.syncBreakpoints(path);
    }
  }

  private async syncBreakpoints(path: string): Promise<void> {
    if (!this.client) return;
    const lines = (store().breakpoints[path] ?? []).map((b) => b.line);
    try {
      const res = await this.client.request<{ breakpoints: Breakpoint[] }>(
        "setBreakpoints",
        {
          source: { path },
          breakpoints: lines.map((line) => ({ line })),
        },
      );
      const verified = (res?.breakpoints ?? []).map((b, i) => ({
        requested: lines[i],
        line: b.line ?? lines[i],
        verified: b.verified,
      }));
      store().setBreakpointsVerified(path, verified);
      if (lines.length) {
        const ok = verified.filter((v) => v.verified).length;
        const name = path.split(/[\\/]/).pop() ?? path;
        this.appendOut(
          `${name}: ${ok}/${lines.length} breakpoint(s) verified (lines ${lines.join(", ")}).`,
        );
      }
    } catch (e) {
      this.appendErr(`setBreakpoints failed: ${msg(e)}`);
    }
  }

  private async cleanup(status: "inactive" | "terminated"): Promise<void> {
    const client = this.client;
    this.client = null;
    this.activeThreadId = null;
    this.caps = {};
    store().clearRuntime();
    store().setStatus(status);
    await client?.dispose().catch(() => {});
  }

  private fail(message: string): void {
    this.appendErr(message);
    void this.cleanup("terminated");
  }

  private appendErr(text: string): void {
    store().appendOutput({ category: "stderr", text: text + "\n" });
  }
  private appendOut(text: string): void {
    store().appendOutput({ category: "console", text: text + "\n" });
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const debugController = new DebugController();
