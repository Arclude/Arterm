# Writing Arterm Extensions

Arterm extensions come in two flavors:

- **Declarative** (Phase 1) — a single JSON file that contributes **themes** and
  **snippets**. Runs **no code**; installing one is completely safe.
- **Executable** (Phase 2) — ships a JavaScript entry file that runs inside a
  **sandboxed Web Worker** and can register **commands** that call a host API.
  See [Executable extensions](#executable-extensions-phase-2) below.

> **Status / scope.** The **declarative** path (themes + snippets, distributed
> via a GitHub static registry) is the supported, public path. **Executable
> extensions are experimental** and surfaced under a *Beta* label — the public
> marketplace lists declarative packages only. The packaging/signing/hosted-
> marketplace pieces below are kept for future "open ecosystem" work and are not
> part of the public launch.

## Package format

A package is one file named **`arterm-extension.json`**. Authors may share it as
`.arterm-ext` or `.json`. On disk an installed extension lives at:

```
{appLocalData}/extensions/<folder>/arterm-extension.json
```

(`<folder>` is derived from the `id`. On Windows the root is
`%LOCALAPPDATA%\com.arclude.arterm\extensions`.)

## Manifest reference

```jsonc
{
  "id": "yourname.cool-pack",        // required. unique. [A-Za-z0-9._-]; also the folder name
  "name": "Cool Pack",               // required. display name
  "version": "1.0.0",                // required. dotted numbers; enables update detection
  "author": "yourname",              // optional
  "description": "What it adds.",    // optional
  "engines": { "arterm": "^0.7.0" },  // optional, informational
  "permissions": [],                 // optional, informational (declarative packages need none)
  "contributes": {
    "themes":   [ /* Theme[] */ ],
    "snippets": [ /* {handle,name,description,content}[] */ ]
  }
}
```

### `contributes.themes` — a `Theme`

```jsonc
{
  "id": "midnight-ocean",            // required. unique within your package
  "name": "Midnight Ocean",          // required
  "author": "yourname",              // optional
  "description": "Deep blue dark.",  // optional
  "variants": {                      // required. at least one of light/dark
    "dark": {
      "colors": {                    // optional UI tokens (shadcn): background, foreground,
        "background": "#0b1220",     //   primary, accent, card, muted, border, sidebar… (all optional)
        "foreground": "#cdd9e5",
        "primary": "#4cc9f0",
        "accent": "#2a9d8f"
      },
      "terminal": {                  // optional xterm palette
        "background": "#0b1220",
        "foreground": "#cdd9e5",
        "cursor": "#4cc9f0",
        "selection": "#1d3a5f",
        "ansi": [ /* exactly 16 hex colors: 8 normal + 8 bright */ ]
      }
    }
  }
}
```

- Provide `light` and/or `dark`. Omitted color keys fall back to the app default.
- Theme ids are **namespaced** internally to `ext:<extId>:<themeId>` so they never
  collide with built-in or user themes. You just write the short `id`.

### `contributes.snippets` — a snippet

```jsonc
{
  "handle": "explain",                          // required. matches ^[a-z0-9][a-z0-9-]*$ ; used as "#explain"
  "name": "Explain this",                       // shown in the snippet picker
  "description": "Ask the AI to explain output.",
  "content": "Explain the following output:\n"  // required. inserted when you type #handle
}
```

Type `#handle` in the AI composer to expand the snippet.

## Executable extensions (Phase 2)

An executable extension adds a JS entry file plus a few manifest fields. The code
runs in a **Web Worker sandbox** — no DOM, no `window`, no direct filesystem.
Everything it can do comes from the injected `arterm` API, and anything that
touches the user's files or environment is gated by a declared **permission**.

### Extra manifest fields

```jsonc
{
  // …all the Phase-1 fields…
  "main": "main.js",                 // entry file, stored next to the manifest
  "activationEvents": [              // when the code is loaded (lazy by default)
    "onCommand:hello.world",         //   activate when this command runs
    "onStartup"                      //   or eagerly at app start ("*" = always)
  ],
  "permissions": ["fs:read"],        // ENFORCED — see the table below
  "contributes": {
    "commands": [
      { "command": "hello.world", "title": "Hello World", "category": "Hello" }
    ]
  }
}
```

Contributed commands appear in the command palette immediately (under their
`category`/title). The extension's code is **not** run until one of its commands
is invoked or an activation event fires — so a big extension costs nothing until
it is actually used.

### The entry file

`main.js` receives `arterm`, `module`, `exports`, and `console`. Set
`exports.activate(context)`; push disposables to `context.subscriptions`:

```js
exports.activate = (context) => {
  context.subscriptions.push(
    arterm.commands.registerCommand("hello.world", () => {
      arterm.window.showInformationMessage("👋 Hello!");
    }),
  );
};
exports.deactivate = () => {};
```

A complete, copy-pasteable template lives in
[`examples/extensions/hello-command/`](../examples/extensions/hello-command/).

### The `arterm` API (so far)

| Method | Permission | Notes |
| --- | --- | --- |
| `arterm.commands.registerCommand(id, fn)` | — | bind a command handler; returns a disposable |
| `arterm.commands.executeCommand(id, ...args)` | — | run another registered command |
| `arterm.window.showInformationMessage(msg)` | — | toast |
| `arterm.window.showWarningMessage(msg)` | — | toast |
| `arterm.window.showErrorMessage(msg)` | — | error toast |
| `arterm.workspace.fs.readTextFile(path)` | `fs:read` | returns file text (throws on binary/too-large) |
| `arterm.workspace.fs.writeTextFile(path, text)` | `fs:write` | writes atomically in the workspace |

Calling a gated method without declaring its permission is **rejected** by the
host with a clear error — the worker can never reach a capability you did not ask
for. The API surface grows over time; this table is the current contract.

> Inline alternative: instead of `main` + `main.js`, a tiny extension may set
> `"mainSource"` to the JS source as a string. Handy for a single-file JSON you
> share directly; `main` takes precedence when both are present.

## Installing & testing locally

1. **Settings → Extensions → From file** — pick your `arterm-extension.json`.
2. Or drop the folder into the extensions directory (Settings → Extensions →
   **Open folder**) and click **Reload**.
3. Enable/disable and uninstall from the same Extensions tab. A contributed
   theme then appears in **Settings → Themes**; a snippet via `#handle`.

Bad themes/snippets are dropped individually; a structurally invalid manifest is
rejected before it is written.

## Publishing to the GitHub marketplace

Arterm's marketplace is a GitHub-hosted **registry index** — a single `index.json`.

1. Host your `arterm-extension.json` somewhere on GitHub (your repo). Get its
   **raw** URL (`https://raw.githubusercontent.com/<owner>/<repo>/<ref>/.../arterm-extension.json`).
2. Open a PR adding one entry to the registry repo's `index.json`:

```jsonc
{
  "id": "yourname.cool-pack",        // MUST equal manifest.id
  "name": "Cool Pack",
  "description": "What it adds.",
  "author": "yourname",
  "version": "1.0.0",               // SHOULD equal manifest.version (drives update detection)
  "manifestUrl": "https://raw.githubusercontent.com/<owner>/<repo>/<ref>/.../arterm-extension.json",
  "homepage": "https://github.com/<owner>/<repo>",
  "tags": ["theme", "snippet"]
}
```

Users browse it in **Settings → Marketplace** and click Install. They can also
**Install from URL** (a raw manifest URL or `owner/repo`) without the registry.

The default registry URL is configurable in the Marketplace tab; see
`examples/registry/index.json` for a template and `examples/extensions/` for
complete sample packages.

## Security model

- **Declarative packages run no code** — a theme/snippet package cannot execute.
- **Executable packages run only in a Web Worker sandbox** — no DOM, no `window`,
  no Tauri/filesystem globals. The worker reaches the app solely through the
  `arterm` API over a message bridge.
- **Capabilities are permission-gated** — sensitive `arterm` methods (e.g.
  `workspace.fs.*`) are denied unless the manifest declares the matching
  permission. Enforcement happens on the main thread (the host), not in the
  worker, so extension code cannot bypass it.
- Remote fetches are **https-only**, SSRF-hardened, and size-capped in the backend.
- The `id` is sanitized into a folder name; sibling file names are validated and
  path traversal is rejected; written files are size- and count-capped.
