# Writing Artex Extensions

Artex extensions (Phase 1) are **declarative packages** — a single JSON file that
contributes **themes** and **snippets**. They run **no code**, so installing one
is safe and needs no zip or build step.

> Code extensions (commands, keybindings, AI tools) are a planned Phase 2 and
> will require a sandbox; this document covers the declarative format only.

## Package format

A package is one file named **`artex-extension.json`**. Authors may share it as
`.artex-ext` or `.json`. On disk an installed extension lives at:

```
{appLocalData}/extensions/<folder>/artex-extension.json
```

(`<folder>` is derived from the `id`. On Windows the root is
`%LOCALAPPDATA%\com.arclude.artex\extensions`.)

## Manifest reference

```jsonc
{
  "id": "yourname.cool-pack",        // required. unique. [A-Za-z0-9._-]; also the folder name
  "name": "Cool Pack",               // required. display name
  "version": "1.0.0",                // required. dotted numbers; enables update detection
  "author": "yourname",              // optional
  "description": "What it adds.",    // optional
  "engines": { "artex": "^0.7.0" },  // optional, informational
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

## Installing & testing locally

1. **Settings → Extensions → From file** — pick your `artex-extension.json`.
2. Or drop the folder into the extensions directory (Settings → Extensions →
   **Open folder**) and click **Reload**.
3. Enable/disable and uninstall from the same Extensions tab. A contributed
   theme then appears in **Settings → Themes**; a snippet via `#handle`.

Bad themes/snippets are dropped individually; a structurally invalid manifest is
rejected before it is written.

## Publishing to the GitHub marketplace

Artex's marketplace is a GitHub-hosted **registry index** — a single `index.json`.

1. Host your `artex-extension.json` somewhere on GitHub (your repo). Get its
   **raw** URL (`https://raw.githubusercontent.com/<owner>/<repo>/<ref>/.../artex-extension.json`).
2. Open a PR adding one entry to the registry repo's `index.json`:

```jsonc
{
  "id": "yourname.cool-pack",        // MUST equal manifest.id
  "name": "Cool Pack",
  "description": "What it adds.",
  "author": "yourname",
  "version": "1.0.0",               // SHOULD equal manifest.version (drives update detection)
  "manifestUrl": "https://raw.githubusercontent.com/<owner>/<repo>/<ref>/.../artex-extension.json",
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

- **No code executes** — only declarative data; a malicious package cannot run code.
- Remote fetches are **https-only**, SSRF-hardened, and size-capped in the backend.
- The `id` is sanitized into a folder name; path traversal is rejected.
