<div align="center">
  <img src="public/logo.png" width="144" height="144" alt="Arterm" />
  <h1>Arterm</h1>

  <p><strong>Lightweight Terminal-first AI-native dev workspace.</strong></p>

  <p>
    <img src="https://img.shields.io/github/v/release/Arclude/Arterm?label=version&color=blue" alt="version" />
    <img src="https://img.shields.io/badge/license-Apache--2.0-green" alt="license" />
    <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey" alt="platform" />
  </p>

  <p>
    <a href="https://arterm.dev">Website</a>
    ·
    <a href="https://arterm.dev/docs">Docs</a>
    ·
    <a href="https://github.com/Arclude/Arterm-website">Website's source code</a>
  </p>
</div>

---

> **Attribution:** Arterm is a fork of [terax-ai](https://github.com/crynta/terax-ai) by [@crynta](https://github.com/crynta), licensed under [Apache 2.0](LICENSE). All credit for the original architecture and implementation goes to the upstream project.

Arterm is a lightweight open-source terminal (ADE) built on Tauri 2 + Rust and React 19. A native PTY backend with a WebGL renderer, an agentic AI side-panel that runs against your own keys or fully local models, plus a code editor, file explorer, source control with a git graph, and a web preview pane built in. About 7-8 MB on disk. No telemetry. No account.

## Screenshots

<table>
  <tr>
    <td align="center"><img src="docs/terminal.png" alt="Terminal" /><br/><sub>Multi-tab terminal with WebGL rendering</sub></td>
    <td align="center"><img src="docs/themes.png" alt="Themes and background image" /><br/><sub>Custom themes, presets, and background images</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/web-preview.png" alt="Web preview" /><br/><sub>Web preview of local dev servers</sub></td>
    <td align="center"><img src="docs/source-control.png" alt="Source control and git graph" /><br/><sub>Source control panel with git graph in history</sub></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><img src="docs/ai-workflow.png" alt="AI window" /><br/><sub>Agentic AI workflow with edit diffs in the code editor</sub></td>
  </tr>
</table>

## What's new since the fork

Arterm forked from [terax-ai](https://github.com/crynta/terax-ai) in June 2026 (around v0.7.3). Everything below was built on top of the upstream project since then:

- **Language intelligence (LSP)** — diagnostics, completions, hover tooltips, symbol breadcrumbs, and a one-click language server install manager
- **Python debugger (DAP)** — full Debug Adapter Protocol integration: breakpoints, stepping, variable inspection
- **Extension system + marketplace** — declarative UI and executable extensions, installable from an in-app marketplace backed by a self-hosted Axum + Postgres registry
- **Multi-agent AI panel** — multiple concurrent background AI sessions with per-session approval routing
- **Ctrl+K command generation** — natural-language to shell command, inline in the terminal
- **AI error assistant** — failed commands get a one-click explanation and suggested fix
- **Editor upgrades** — minimap, split editor groups with tab drag-and-drop, live-synced split documents, breadcrumb bar, richer completion popup, large-file performance mode
- **Quick-open** — fuzzy workspace file search from the command palette
- **Source control & status bar** — branch switcher, git pull, customizable status bar with rich git status, image preview
- **Quality of life** — plain Ctrl+C/Ctrl+V in the terminal, faster file explorer on busy filesystems, end-to-end auto-update with its own signing key

## Features

### Terminal

- xterm.js with WebGL renderer, multi-tab with background streaming
- Native PTY backend via `portable-pty` (zsh, bash, pwsh, fish, cmd)
- Split panels (horizontal and vertical)
- Inline search, link detection, true-color
- Per-tab workspace environments on Windows (Local, or any installed WSL distro)
- **Ctrl+K** natural-language command generation — describe what you want, get the shell command inline
- AI error assistant — when a command fails, get a one-click explanation and suggested fix
- Plain Ctrl+C / Ctrl+V copy & paste

### Code editor

- CodeMirror 6 (supports all popular languages - TS/JS, Rust, Python, Go, C/C++, Java, HTML/CSS, JSON, Markdown, etc.)
- Inline AI autocomplete with local model support
- AI edit diffs, accept or reject hunk by hunk
- Split editor groups with tab drag-and-drop; split views share a live-synced document
- Minimap with syntax colors, richer completion popup, visible scrollbar
- Breadcrumb bar with symbol path navigation
- Quick-open workspace file search from the command palette
- Large-file performance mode — heavy features gate off automatically on big files
- Vim mode
- Ten built-in editor themes: Atom One, Aura, Copilot, GitHub Dark / Light, Gruvbox Dark, Nord, Tokyo Night, Xcode Dark / Light

### Language intelligence (LSP)

- Language Server Protocol support: diagnostics, completions, and hover tooltips on symbols
- One-click language server install manager — pick a language, Arterm installs and wires up the server

### Debugger (DAP)

- Python debugging via the Debug Adapter Protocol: breakpoints, stepping, variable inspection
- More languages planned through the same DAP layer

### Extensions

- Built-in extension system with an in-app marketplace
- Declarative UI extensions (Beta) and executable extensions
- Self-hosted registry backend (Axum + Postgres)

### Source control

- Stage / unstage hunks, commit (Cmd+Enter / Ctrl+Enter), push and pull with upstream awareness
- Branch display including detached HEAD state, branch switcher in the status bar
- Git history pane with a real commit graph (lane rendering for merges and branches)
- Commit search and filter, click through to the remote commit page
- Customizable status bar with rich git status

### File explorer

- Catppuccin icon theme
- Fuzzy search, keyboard navigation, inline rename, context actions
- Attach files and selections directly to the AI side-panel

### Web preview

- Auto-detects local dev servers and opens them in a preview tab
- External URL preview via a native child webview

### Themes and customization

- Custom themes built in-app, switch between bundled presets and your own
- Create your own themes, share them or import from the community
- Background images with adjustable opacity and blur
- Editor theme is independent from the app theme

### AI

- **BYOK providers:** OpenAI, Anthropic, Google (Gemini), Groq, xAI (Grok), Cerebras, OpenRouter, DeepSeek, Mistral, plus any OpenAI-compatible endpoint
- **Local / offline:** LM Studio, MLX, Ollama
- **Agentic workflow:** plans, sub-agents, project memory via `ARTERM.md`, file read / write / edit / multi-edit / grep / glob, bash with approval gating, background processes
- **Composer:** snippets via `#handle`, files via `@path`, slash commands, voice input, attach-to-agent from explorer or selection
- **Custom agents** with their own system prompt and tool subset
- **Plan mode** for multi-step work, generates and confirms before doing
- **Multi-agent panel:** run multiple AI sessions concurrently in the background and switch between them; approvals route to the right session

## Install

Latest installers are on the [Releases](https://github.com/Arclude/Arterm/releases/latest) page. Arterm auto-updates from there.

### Windows notes

- On first launch Windows shows "Windows protected your PC" because Arterm isn't code-signed yet. Click **More info** then **Run anyway**.
- Default shell detection: `pwsh.exe` (PowerShell 7+) -> `powershell.exe` (Windows PowerShell 5.1) -> `cmd.exe`.
- WSL is a first-class workspace environment, not a wrapped subprocess.

### Linux notes

- **Arch / AUR:** `yay -S arterm-bin` (or `paru`, etc.). Tracks the latest release.
- **AppImage:** needs FUSE. Without it: `./Arterm_*.AppImage --appimage-extract-and-run`. On Wayland with rendering glitches, try `WEBKIT_DISABLE_DMABUF_RENDERER=1`. Otherwise the `.deb` / `.rpm` packages link against the system GTK stack and tend to be smoother.

## Configure AI

1. Open **Settings -> AI**.
2. Pick a provider and paste your API key. For local inference, point Arterm at your LM Studio / MLX / Ollama endpoint.
3. Keys are written to the OS keychain via `keyring`. They never touch disk or localStorage.

## Build from source

**Prerequisites**
- Rust (stable), https://rustup.rs
- Node 20+ and [pnpm](https://pnpm.io)
- Tauri prerequisites for your platform, https://tauri.app/start/prerequisites/

**Run**
```bash
pnpm install
pnpm tauri dev          # development
pnpm tauri build        # production bundle
```

**Checks**
```bash
pnpm exec tsc --noEmit                                            # frontend type-check
cd src-tauri && cargo clippy --all-targets --locked -D warnings   # Rust lint (matches CI)
cd src-tauri && cargo test --locked                               # Rust tests
```

## Tech stack

Tauri 2, Rust, `portable-pty`, React 19, TypeScript, Vite, xterm.js, CodeMirror 6, Vercel AI SDK v6, Tailwind v4, shadcn/ui, Zustand.

## Contributing

Issues and PRs are welcome! Feel free to open issues, suggest features, or submit pull requests. See [CONTRIBUTING.md](CONTRIBUTING.md) for more details.

## License

Arterm is licensed under the Apache-2.0 License. For more information on our dependencies, see [Apache License 2.0](LICENSE).

## Star history

<div align="center">
  <a href="https://www.star-history.com/#Arclude/Arterm&Date">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Arclude/Arterm&type=Date&theme=dark" />
      <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Arclude/Arterm&type=Date" />
      <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=Arclude/Arterm&type=Date" />
    </picture>
  </a>
</div>
