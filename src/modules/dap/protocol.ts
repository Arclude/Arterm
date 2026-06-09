// Minimal Debug Adapter Protocol type subset — only what the MVP single-session
// stdio debugger touches. Full spec:
// https://microsoft.github.io/debug-adapter-protocol/specification

export type DapMessage = DapRequest | DapResponse | DapEvent;

export type DapRequest = {
  seq: number;
  type: "request";
  command: string;
  arguments?: unknown;
};

export type DapResponse = {
  seq: number;
  type: "response";
  request_seq: number;
  success: boolean;
  command: string;
  message?: string;
  body?: unknown;
};

export type DapEvent = {
  seq: number;
  type: "event";
  event: string;
  body?: unknown;
};

// --- Capabilities (subset) ---
export type Capabilities = {
  supportsConfigurationDoneRequest?: boolean;
  supportsFunctionBreakpoints?: boolean;
  supportsConditionalBreakpoints?: boolean;
  supportsTerminateRequest?: boolean;
  supportsSingleThreadExecutionRequests?: boolean;
};

// --- Events ---
export type StoppedEvent = {
  reason: string; // "breakpoint" | "step" | "exception" | "entry" | "pause" | ...
  description?: string;
  threadId?: number;
  text?: string;
  allThreadsStopped?: boolean;
  hitBreakpointIds?: number[];
};

export type ContinuedEvent = {
  threadId: number;
  allThreadsContinued?: boolean;
};

export type ThreadEvent = {
  reason: "started" | "exited";
  threadId: number;
};

export type OutputEvent = {
  category?: string; // "console" | "stdout" | "stderr" | "important" | ...
  output: string;
  source?: Source;
  line?: number;
};

export type TerminatedEvent = { restart?: unknown };
export type ExitedEvent = { exitCode: number };

// --- Core structures ---
export type Source = {
  name?: string;
  path?: string;
  sourceReference?: number;
};

export type SourceBreakpoint = {
  line: number; // 1-based
  column?: number;
  condition?: string;
};

export type Breakpoint = {
  id?: number;
  verified: boolean;
  message?: string;
  source?: Source;
  line?: number;
  column?: number;
};

export type Thread = { id: number; name: string };

export type StackFrame = {
  id: number;
  name: string;
  source?: Source;
  line: number; // 1-based
  column: number; // 1-based
  presentationHint?: string;
};

export type Scope = {
  name: string;
  variablesReference: number;
  expensive: boolean;
  presentationHint?: string;
};

export type Variable = {
  name: string;
  value: string;
  type?: string;
  variablesReference: number; // >0 means expandable
  namedVariables?: number;
  indexedVariables?: number;
};

// --- Launch config for Python / debugpy ---
export type PythonLaunchConfig = {
  request: "launch";
  type: "python";
  program: string;
  cwd?: string;
  console?: "internalConsole" | "integratedTerminal" | "externalTerminal";
  stopOnEntry?: boolean;
  args?: string[];
  justMyCode?: boolean;
  env?: Record<string, string>;
};
