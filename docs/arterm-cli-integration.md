<!-- Mirrored verbatim from the Arterm-CLI repo: docs/desktop-integration.md (source of truth). Keep in sync — any deviation must update both copies in the same change. -->

# Arterm Desktop Integration Protocol — v1

The contract between **Arterm-CLI** (this repo) and the **Arterm desktop app**
(github.com/Arclude/Arterm) for live session monitoring and control. The CLI runs an
in-process, loopback-only HTTP + SSE status server; the desktop discovers running sessions
via discovery files and renders them in its "CLI Agents" sidebar tab.

Both sides build **only** against this document. Any deviation requires updating this file
and its mirror in the desktop repo (`docs/arterm-cli-integration.md`) in the same change.

## 1. Discovery

Every CLI process with the status server enabled writes a discovery file:

```
~/.arterm/status/<pid>.json
```

- Written **atomically** (write to a temp file in the same directory, then rename).
- Removed on clean exit (`close()` and a best-effort `process.on("exit")` unlink).
- On every status-server start, the CLI **sweeps** the directory: any file whose `pid` is
  not alive (`process.kill(pid, 0)` → `ESRCH`) is deleted.
- File mode `0o600` best-effort. On Windows `chmod` is a no-op; the real boundary is the
  home-directory ACL. Same-user processes can read the token — they are inside the trust
  boundary (see §4).

```json
{
  "v": 1,
  "pid": 31264,
  "sessionId": "3f6d2a1e-9c4b-4c6e-b1a2-0e8f7d6c5b4a",
  "port": 53817,
  "token": "9f2c8a7b6e5d4c3b2a190817263544f5",
  "cwd": "C:\\Users\\me\\proj",
  "model": "qwen2.5-coder:7b",
  "provider": "ollama",
  "startedAt": 1783853172981,
  "terminalId": 3
}
```

- `sessionId` — UUID v4, stable for the process lifetime. The desktop keys sessions by it.
- `port` — the real listening port (the server binds port `0` by default; the OS assigns).
- `token` — 32 hex chars (128-bit), regenerated every process start.
- `terminalId` — present **only** when the env var `ARTERM_TERMINAL_ID` is set (the desktop
  sets it to the PTY id for every terminal it spawns). Used for terminal-tab association.
- `model` / `provider` — informational; may be stale after a mid-session `/model` switch
  (the snapshot is authoritative).
- Consumers MUST ignore unknown fields. Producers MUST NOT remove fields within `v: 1`.

## 2. HTTP surface

Binds `127.0.0.1` only. No CORS headers are ever emitted. Requests whose `Host` header is
not `127.0.0.1[:port]` or `localhost[:port]` are rejected with `403` (DNS-rebinding guard).

**Auth**: every route except `/api/health` requires the token, either as
`Authorization: Bearer <token>` or `?token=<token>` query param. Missing/wrong →
`401 {"error":"unauthorized"}`.

| Route | Auth | Method | Response |
|---|---|---|---|
| `/api/health` | no | GET | `200 {"v":1,"ok":true,"pid":<n>,"sessionId":"<uuid>"}` |
| `/api/state` | yes | GET | `200 {"v":1,"state":<StatusSnapshot>}` |
| `/api/stream[?since=<seq>]` | yes | GET | SSE stream, frames in §3 |
| `/api/control` | yes | POST | `200 {"ok":<bool>,"error"?:<string>,"state":<StatusSnapshot>}` |

Errors: `400` malformed JSON body (or body > 64 KB), `401` auth, `403` bad Host, `404`
unknown route, `405` wrong method. `POST /api/control` with an unknown or currently-invalid
action returns `200 {"ok":false,"error":"...","state":...}` — never `500`; all autonomy
controls are safe no-ops when no run is active.

### Control body

```ts
{
  action: "pause" | "resume" | "stop" | "steer" | "goal" | "mode";
  note?: string;   // REQUIRED for "steer" (steer text) and "goal" (the new goal)
  mode?: string;   // REQUIRED for "mode": an AutonomyMode ("once"|"eternal"|"parallel"|"phased"|"team")
}
```

`mode` returns `ok:false` when a run is in progress (mode cannot change mid-run).

## 3. SSE frames (`content-type: text/event-stream`)

- **On connect** — one full-state frame:
  ```
  event: snapshot
  data: {"v":1,"state":<StatusSnapshot>,"events":<StampedEvent[]>}
  ```
  `events` is the in-memory ring backlog (max 500, oldest first). With `?since=<seq>` only
  events with `seq > since` are included (reconnect resume).
- **Live** — one frame per bus event (`text_delta` is NEVER forwarded):
  ```
  event: agent
  id: <seq>
  data: <StampedEvent>
  ```
- **Throttled state** — at most one per 250 ms, after state-changing events:
  ```
  event: state
  data: <StatusSnapshot>
  ```
- **Keep-alive** — comment `: ping` every 25 s.

## 4. Security model

- Token: `crypto.randomBytes(16).toString("hex")` per process, distributed only via the
  user-readable discovery file.
- Defends against: **other OS users** (file ACL), **web pages** (no CORS + token unknown to
  page origins), **DNS rebinding** (Host header check).
- Does NOT defend against same-user local processes — they are inside the trust boundary
  (they could equally kill the process or edit the repo). This matches the Chrome
  DevTools / JetBrains "port + token file" pattern.

## 5. Shared types

```ts
/** A CLI bus event stamped at the sink. `type` discriminates (see AgentEvent in @arterm/core). */
type StampedEvent = { seq: number; ts: number } & AgentEvent;
// The desktop treats the payload as { seq: number; ts: number; type: string } & Record<string, unknown>.

type TeamMemberStatus = {
  id: string;            // e.g. "m1-reviewer" — stable across the run
  name: string;
  description: string;
  adhoc: boolean;
  state: "pending" | "running" | "done" | "failed";
  task?: string;         // latest assignment
  activity?: string;     // "⚙ <tool>" | "✎ writing" | "⊘ denied"
  filesChanged?: number;
  // Live per-member telemetry (accumulated server-side from the member's inner events).
  toolUseCount: number;          // count of the member's tool_call events
  tokenCount: number;            // sum of the member's prompt+completion tokens
  recentActivities: string[];    // rolling window (max 5), newest last
  startedAt?: number;            // epoch ms of first `running` transition (for elapsed)
  lastActivityAt?: number;       // epoch ms of the member's most recent activity (for idle)
};

type StatusSnapshot = {
  v: 1;
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;               // epoch ms
  status: "idle" | "thinking" | "tool";
  model: string;
  provider: string;
  permissionMode: string;          // "ask" | "auto" | "plan" | "yolo"
  toolCount: number;
  tokens: { in: number; out: number; ctx: number };
  activeTool: string | null;
  rounds: number;                  // completed turns
  autonomy: {                      // = AutonomyEngine.snapshot(), verbatim
    state: "idle" | "running" | "paused" | "done" | "stopped";
    mode: string;
    goal: string;
    step: number;
    phases: { id: string; title: string; done: string; parallel?: boolean }[];
    team: { id: string; name: string; description: string; adhoc: boolean }[];
  };
  fleet: { active: number; round: number };
  workers: { task: string; role?: string; state: "running" | "done"; output?: string }[];
  team: TeamMemberStatus[];        // accumulated live board (§6)
  main: {                          // live telemetry for the primary (non-member) agent (§6)
    toolUseCount: number;          // count of the main agent's tool_call events
    recentActivities: string[];    // rolling window (max 5), newest last — same format as a member's
  };
  activeAgents: number;            // server-computed (§7) — rail badge = sum over sessions
  seq: number;                     // seq of the last stamped event folded into this snapshot
};
```

**Versioning**: `v: 1` appears in the discovery file, `/api/health`, `/api/state`, the SSE
`snapshot` frame, and the control response. Additive fields do NOT bump `v`. On `v !== 1`
the desktop shows "unsupported protocol — update Arterm CLI" for that session.

## 6. Team accumulation semantics

Mirrors the CLI TUI (`packages/tui/src/App.tsx` bus switch):

- `team_plan {members}` — reset the board; seed every member with `state: "pending"`.
- `team_member_state {id, state, task?, filesChanged?}` — update the member in place.
  While the new state is `running` the previous `activity` is kept; transitioning to any
  other state (`pending`/`done`/`failed`) clears `activity`.
- `team_member_event {id, event}` — updates `lastActivityAt`, and:
  - `tool_call` → `activity = "⚙ <tool name>"`, `toolUseCount += 1`, append to `recentActivities`.
  - `assistant_message` → `activity = "✎ writing"`, append to `recentActivities`.
  - `tool_denied` → `activity = "⊘ denied"`, append to `recentActivities`.
  - `usage` → `tokenCount += promptTokens + completionTokens`.
  `recentActivities` is capped at 5 (newest last). Other inner types are ignored.
- `team_done` — the board persists (final states visible) until the next `team_plan`.

Per-member telemetry (`toolUseCount`, `tokenCount`, `recentActivities`, `startedAt`,
`lastActivityAt`) is accumulated server-side and included in every `StatusSnapshot`, so a
consumer that renders from snapshots needs no client-side event accumulation. `startedAt` is
stamped on the member's first `running` transition.

The **main (coordinator) agent** gets the same treatment via the top-level `main` field:
its `toolUseCount` and `recentActivities` are accumulated server-side from the primary
(non-member) `tool_call` (`"⚙ <tool>"`) and `assistant_message` (`"✎ writing"`) bus events,
using the identical 5-entry rolling-window format as a member's `recentActivities`. This lets
the desktop render main as a first-class node (the parent in the 2-level topology) rather than
a second-class card. Additive field — an older `v: 1` CLI omits it, so consumers default it to
`{ toolUseCount: 0, recentActivities: [] }`.

## 7. `activeAgents`

Computed server-side:

```
activeAgents =
    (status !== "idle" || autonomy.state === "running" ? 1 : 0)   // the main agent
  + count(team[].state === "running")
  + count(workers[].state === "running")
  + fleet.active
```

The desktop's rail badge is `sum(activeAgents)` over all live (health-checked) sessions.

## 8. CLI server lifecycle

- Config block (`~/.arterm/config.json`): `statusServer: { enabled: boolean | "auto", port: number }`,
  default `{ enabled: "auto", port: 0 }`.
- `"auto"` starts the server iff `process.env.ARTERM_TERMINAL` is set (the desktop sets it
  for every PTY it spawns). `true` always starts, `false` never.
- CLI flags override config: `--status-port <port>` (implies enabled, pins the port),
  `--no-status-server` (disables).
- Runs in both TUI and headless (`--print`) flows. Server start failure is a stderr warning,
  never fatal.
