import { create } from "zustand";
import type { Scope, StackFrame, Thread, Variable } from "./protocol";

// Reactive snapshot of the debug session for the UI. The imperative session
// controller (session.ts) owns the DapClient and pushes updates here; React
// components and the CodeMirror gutter read from this store.
//
// Breakpoints live here (not in the session) so they persist across sessions
// and the editor gutter can toggle them even when nothing is running.

export type DebugStatus =
  | "inactive"
  | "starting"
  | "running"
  | "stopped"
  | "terminated";

export type StoreBreakpoint = {
  line: number; // 1-based, matches DAP
  verified: boolean;
};

export type OutputLine = {
  category: string;
  text: string;
};

export type StoppedLocation = {
  path: string;
  line: number; // 1-based
};

type DebugState = {
  status: DebugStatus;
  /** Absolute file path -> breakpoints. Persists across sessions. */
  breakpoints: Record<string, StoreBreakpoint[]>;
  threads: Thread[];
  activeThreadId: number | null;
  frames: StackFrame[];
  activeFrameId: number | null;
  scopes: Scope[];
  /** Lazily-loaded children keyed by variablesReference. */
  variablesByRef: Record<number, Variable[]>;
  output: OutputLine[];
  /** Where execution is paused — drives the editor execution-line highlight. */
  stoppedAt: StoppedLocation | null;
  /** Config currently being debugged, for the panel header. */
  programName: string | null;

  // --- breakpoint actions (usable with no active session) ---
  toggleBreakpoint: (path: string, line: number) => void;
  setBreakpointsVerified: (
    path: string,
    updates: { requested: number; line: number; verified: boolean }[],
  ) => void;
  clearBreakpoints: (path: string) => void;

  // --- session-driven setters ---
  setStatus: (status: DebugStatus) => void;
  setThreads: (threads: Thread[]) => void;
  setStopped: (
    threadId: number,
    frames: StackFrame[],
    location: StoppedLocation | null,
  ) => void;
  setActiveFrame: (frameId: number, scopes: Scope[]) => void;
  setVariables: (ref: number, variables: Variable[]) => void;
  appendOutput: (line: OutputLine) => void;
  setRunning: () => void;
  /** Clear execution state (frames/scopes/threads/location) without touching
   * status, output, or breakpoints. Used on session teardown. */
  clearRuntime: () => void;
  reset: (programName?: string | null) => void;
};

const MAX_OUTPUT_LINES = 5000;

export const useDebugStore = create<DebugState>((set) => ({
  status: "inactive",
  breakpoints: {},
  threads: [],
  activeThreadId: null,
  frames: [],
  activeFrameId: null,
  scopes: [],
  variablesByRef: {},
  output: [],
  stoppedAt: null,
  programName: null,

  toggleBreakpoint(path, line) {
    set((s) => {
      const existing = s.breakpoints[path] ?? [];
      const has = existing.some((b) => b.line === line);
      const next = has
        ? existing.filter((b) => b.line !== line)
        : [...existing, { line, verified: false }].sort(
            (a, b) => a.line - b.line,
          );
      const breakpoints = { ...s.breakpoints };
      if (next.length) breakpoints[path] = next;
      else delete breakpoints[path];
      return { breakpoints };
    });
  },

  setBreakpointsVerified(path, updates) {
    set((s) => {
      const existing = s.breakpoints[path];
      if (!existing) return s;
      // Match by the line we requested; adopt the adapter's actual line (it may
      // shift a breakpoint to the next executable line) and its verified flag.
      const byReq = new Map(updates.map((u) => [u.requested, u]));
      const next = existing
        .map((b) => {
          const u = byReq.get(b.line);
          return u ? { line: u.line, verified: u.verified } : b;
        })
        .sort((a, b) => a.line - b.line);
      return { breakpoints: { ...s.breakpoints, [path]: next } };
    });
  },

  clearBreakpoints(path) {
    set((s) => {
      if (!s.breakpoints[path]) return s;
      const breakpoints = { ...s.breakpoints };
      delete breakpoints[path];
      return { breakpoints };
    });
  },

  setStatus(status) {
    set({ status });
  },

  setThreads(threads) {
    set((s) => ({
      threads,
      activeThreadId: s.activeThreadId ?? threads[0]?.id ?? null,
    }));
  },

  setStopped(threadId, frames, location) {
    set({
      status: "stopped",
      activeThreadId: threadId,
      frames,
      activeFrameId: frames[0]?.id ?? null,
      stoppedAt: location,
      scopes: [],
      variablesByRef: {},
    });
  },

  setActiveFrame(frameId, scopes) {
    set({ activeFrameId: frameId, scopes, variablesByRef: {} });
  },

  setVariables(ref, variables) {
    set((s) => ({
      variablesByRef: { ...s.variablesByRef, [ref]: variables },
    }));
  },

  appendOutput(line) {
    set((s) => {
      const output = [...s.output, line];
      if (output.length > MAX_OUTPUT_LINES) {
        output.splice(0, output.length - MAX_OUTPUT_LINES);
      }
      return { output };
    });
  },

  setRunning() {
    set({
      status: "running",
      frames: [],
      activeFrameId: null,
      scopes: [],
      variablesByRef: {},
      stoppedAt: null,
    });
  },

  clearRuntime() {
    set({
      threads: [],
      activeThreadId: null,
      frames: [],
      activeFrameId: null,
      scopes: [],
      variablesByRef: {},
      stoppedAt: null,
    });
  },

  reset(programName = null) {
    set({
      status: "inactive",
      threads: [],
      activeThreadId: null,
      frames: [],
      activeFrameId: null,
      scopes: [],
      variablesByRef: {},
      output: [],
      stoppedAt: null,
      programName,
    });
  },
}));
