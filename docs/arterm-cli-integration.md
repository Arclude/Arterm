<!-- Mirrored verbatim from the Arterm-CLI repo: docs/desktop-integration.md (source of truth). Keep in sync — any deviation must update both copies in the same change. -->

# Arterm Desktop Integration Protocol — v1

The contract between **Arterm-CLI** (this repo) and the **Arterm desktop app**
(github.com/Arclude/Arterm) for live session monitoring and control. The CLI runs an
in-process, loopback-only HTTP + SSE status server; the desktop discovers running sessions
via discovery files and renders them in its "CLI Agents" sidebar tab.

Both sides build **only** against this document. Any deviation requires updating this file
and its mirror in the desktop repo (`docs/arterm-cli-integration.md`) in the same change.

## 1. Discovery

Every CLI **session** with the status server enabled writes a discovery file:

```
~/.arterm/status/<pid>-<sessionId>.json
```

- One interactive CLI process may host **several sessions**; each session runs its own
  status server (own port + token) and writes its own discovery file, so multiple files
  per `pid` are legal. Consumers treat each file as one independent session.
- Written **atomically** (write to a temp file in the same directory, then rename).
- Removed on clean exit (`close()` and a best-effort `process.on("exit")` unlink).
- On every status-server start, the CLI **sweeps** the directory: any file whose `pid` is
  not alive (`process.kill(pid, 0)` → `ESRCH`) is deleted. The pid parses from the leading
  digits of the filename; consumers/sweepers MUST fall back to the `pid` field in the JSON
  body for filenames that don't start with digits (e.g. legacy `<pid>.json` files parse
  either way).
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

- `sessionId` — UUID v4, stable for the session lifetime (= the process lifetime for a
  single-session process). The desktop keys sessions by it.
- `port` — the real listening port (the server binds port `0` by default; the OS assigns).
  Each session in a process has its own port.
- `token` — 32 hex chars (128-bit), generated per session at session start.
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
  action: "pause" | "resume" | "stop" | "steer" | "goal" | "mode" | "permission";
  note?: string;   // REQUIRED for "steer" (steer text) and "goal" (the new goal)
  mode?: string;   // REQUIRED for "mode": an AutonomyMode ("once"|"eternal"|"parallel"|"phased"|"team")
  id?: string;     // REQUIRED for "permission": the pendingPermission.id being answered
  answer?: "allow" | "allow_always" | "deny";  // REQUIRED for "permission"
}
```

`mode` returns `ok:false` when a run is in progress (mode cannot change mid-run).
`permission` answers the prompt currently blocking the agent — see §8.

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
  activeAgents: number;            // server-computed (§7) — rail badge = sum over sessions
  main: {                          // the primary agent as a first-class node (§6)
    toolUseCount: number;          // main's own tool_call count this session
    recentActivities: string[];    // rolling window (max 5), newest last — member format
  };
  pendingPermission: PendingPermission | null;  // the prompt blocking the agent (§8)
  pendingPermissionQueue: number;               // further requests waiting behind it
  seq: number;                     // seq of the last stamped event folded into this snapshot
};

/** A permission prompt awaiting an answer (§8). */
type PendingPermission = {
  id: string;              // quote this in the control call; a fresh id per request
  tool: string;            // tool name, e.g. "write_file"
  preview: string;         // the tool's own prompt preview — line 1 is the summary, the
                           // rest (if any) a diff body; capped at ~4000 chars
  args: Record<string, unknown>;  // tool args; string values over 500 chars are clipped
  category: string;        // "read" | "edit" | "execute"
  riskTier?: string;       // e.g. "destructive" — worth a stronger confirmation in the UI
  requestedAt: number;     // epoch ms
  origin?: {               // the sub-agent that raised it; ABSENT for the main agent
    id?: string;           // its board-row id (same id as team_member_state / _event)
    name: string;          // its role/member name, e.g. "explorer"
  };
};

/** Provider failure taxonomy — lets a UI tell "out of quota" from "wrong API key". */
type ProviderErrorKind =
  | "network" | "timeout" | "auth" | "quota"
  | "overloaded" | "server" | "bad_request" | "unknown";

/** Snapshot field: the failure that ended the LAST turn, else null. */
type StatusError = {
  message: string;
  kind?: ProviderErrorKind;
  provider?: string;
  status?: number;
  retryable?: boolean;   // the same request could plausibly succeed on a retry
  at: number;            // epoch ms
};

/** Snapshot field: the last model switch the fallback chain made, else null. */
type StatusFallback = {
  from: { provider: string; model: string };
  to: { provider: string; model: string };
  reason: ProviderErrorKind;
  detail: string;
  at: number;
};
```

**`lastError` / `lastFallback`** are session *health*, not history — the event ring keeps the
history. The CLI clears `lastError` when a new turn starts; `lastFallback` deliberately
survives across turns, because landing on a backup model is a standing condition worth
showing after the turn it rescued has ended.

`snapshot.model` always names the model you **configured**, even while a backup is answering.
A UI that prints it alone will go on naming a model that is not producing the replies — render
`model↪backup` (both ends: "backup" on its own reads as if the model was changed, when the
configured one is the one that failed).

**`autonomy_verify`** — a result-verification verdict, streamed as an `agent` frame:

```ts
{ type: "autonomy_verify";
  pass: boolean;
  note?: string;
  by?: "command" | "judge";   // the deterministic gate, or the LLM judge behind it
  mustFix?: string[];         // concrete repair items (present on a rejection)
  skipped?: boolean;          // NO verdict could be obtained; the claim passed BY DEFAULT
  attempt?: number;           // 1-based repair attempt
  scope?: "goal" | "phase" | "round" | "task";
  id?: string;                // the phase/round/task id when scope !== "goal"
}
```

It has **three** outcomes, not two: `skipped: true` means the verifier could not produce a
verdict and the claim was accepted anyway. Rendering that as a pass reports a dead API key as
a green check — "unverified" is not "verified", and a UI must be able to say which. When
`scope` is `"task"`, `id` is the same board-row id as `team_member_state`, so a verdict can be
attributed to the worker whose work was judged.

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
- `team_message {round, from, fromName, to?, toName?, kind, text}` — a posting on the shared
  team **blackboard** (breaks the star topology). This is a stream-only event: it is NOT folded
  into the snapshot, so a consumer accumulates it client-side from the SSE `agent` frames.
  - `kind: "message"` — a member's directed/broadcast note (via its `message` tool). `to`/`toName`
    set → a **member→member edge** (`from` → `to`) for a topology graph; `to` absent → a broadcast
    (member → all / the board hub).
  - `kind: "result"` — a member's round output auto-posted to the board at round end. `to` is
    always absent (member → board hub / leader). Emitted once per non-failed member per round.
  - `from`/`to` are member ids matching `team[].id` (or `"leader"` for `from`). `round` is the
    1-based team round. `text` is truncated (~600 chars). Only present when the shared blackboard
    is enabled (`config.team.blackboard`, default on).
- `team_memory {round, member, memberName, kind, text}` — a private note a member left its
  **future self** (via its `memo` tool). Members run isolated per round, so this is how a
  decision or a ruled-out approach survives into their next round; the board covers what a
  member shares, this covers what it keeps. Stream-only, same as `team_message` — accumulate
  it client-side; it is NOT folded into the snapshot.
  - `member` is a member id matching `team[].id`; `round` is the 1-based team round; `text`
    is truncated (~600 chars).
  - `kind: "note"` is the only kind emitted today — treat unknown kinds as ignorable. A
    member's own round output is also recapped into its private memory, but that is NOT
    emitted here: it is already on the wire as the `kind: "result"` `team_message` above.
  - Only present when per-member memory is enabled (`config.team.memory`, default on).
- `team_done` — the board persists (final states visible) until the next `team_plan`.

Per-member telemetry (`toolUseCount`, `tokenCount`, `recentActivities`, `startedAt`,
`lastActivityAt`) is accumulated server-side and included in every `StatusSnapshot`, so a
consumer that renders from snapshots needs no client-side event accumulation. `startedAt` is
stamped on the member's first `running` transition.

The **main agent** is exposed symmetrically as `main: { toolUseCount, recentActivities }`,
accumulated from the top-level (non-member) `tool_call` (`"⚙ <tool>"`) and `assistant_message`
(`"✎ writing"`) events, same 5-entry cap. This lets a consumer render main as a first-class
node alongside `team[]`, which are its implicit children. **Agent topology is one level deep**
— one main agent → a flat set of `team[]` members / `workers[]`; members do not nest, so the
snapshot carries no `parentId` (a consumer synthesizes the single main parent).

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

## 8. Remote permission answering

A permission prompt normally blocks the agent until someone answers it **in the terminal**.
That is useless when the CLI is running in a background tab, so the prompt has two possible
answerers and the first one wins:

- The CLI publishes the waiting request as `pendingPermission` in every snapshot, and emits
  `permission_request { id, tool, preview, category, riskTier?, origin? }` on the stream when it goes
  up. A consumer can render from either (the snapshot covers a late subscriber).
- The desktop answers with `POST /api/control {action:"permission", id, answer}`. `answer` is
  `"allow"` (once), `"allow_always"` (also persists a per-tool override, same as the TUI's
  `[a]`), or `"deny"`.
- Whoever answers first wins. A remote answer tears the TUI prompt down; a local answer makes
  the next remote call fail with `ok:false`.
- `id` MUST match the current `pendingPermission.id`. A stale id is rejected
  (`ok:false, error:"stale permission id …"`) so a click on a prompt that just resolved in the
  terminal can never approve the *next* tool call. `ok:false, error:"no permission request is
  pending"` means nothing is waiting.
- When the answer lands, `permission_resolved { id, tool, answer, via }` is emitted;
  `via` is `"local"` (the terminal) or `"remote"` (this endpoint).
- Sub-agents share one prompt queue: only the head is published as `pendingPermission`, and
  `pendingPermissionQueue` counts the rest. Answering the head promotes the next one.
- Every queue transition also emits `permission_queued { queued }`, for a consumer rendering
  from the event stream alone. A consumer reading the snapshot does NOT need it: the CLI
  schedules a `state` push after *every* bus event, this one included, so
  `pendingPermissionQueue` is at most one throttle window (250 ms) behind — and the `control`
  response carries the post-answer state immediately. Following both is two sources of truth
  for one number, and they can arrive out of order.
- `pendingPermission.origin` names the sub-agent behind the request (absent = the main agent).
  Its `id` is the same board-row id as `team_member_state`, so the UI can point at the row that
  is waiting instead of showing a bare tool name.
- Modes that never prompt (`yolo`, `plan`) simply never produce a `pendingPermission`.

**Security**: this lets a token holder approve a tool call — including a destructive one. That
is the same trust boundary as §4: a same-user process holding the token could already steer the
run (`goal`/`steer`) or edit the repo directly. It does NOT widen the boundary to other users,
web pages, or the network.

## 9. CLI server lifecycle

- Config block (`~/.arterm/config.json`): `statusServer: { enabled: boolean | "auto", port: number }`,
  default `{ enabled: "auto", port: 0 }`.
- `"auto"` starts the server iff `process.env.ARTERM_TERMINAL` is set (the desktop sets it
  for every PTY it spawns). `true` always starts, `false` never.
- CLI flags override config: `--status-port <port>` (implies enabled, pins the port),
  `--no-status-server` (disables).
- Runs in both TUI and headless (`--print`) flows. Server start failure is a stderr warning,
  never fatal.
