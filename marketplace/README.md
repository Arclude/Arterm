# Arterm Marketplace

A small **Axum + Postgres** service that hosts Arterm extensions: publishers push
versions to it, and the Arterm app installs from it. Its `GET /v1/registry`
response matches the shape the app's Marketplace UI already expects, so wiring
the app to your own marketplace is a one-line URL change.

> **Experimental — not part of the public launch.** The supported public
> distribution path is a **GitHub static `index.json` registry** serving
> **declarative** (theme/snippet) packages; see `docs/EXTENSIONS.md` and
> `examples/registry/index.json`. This hosted backend is kept for a future
> "open ecosystem" (publisher tokens, dynamic publish, analytics). Because it
> emits the same `/v1/registry` shape, switching the app to it later is just a
> registry-URL change (plus an HTTPS origin — the app rejects non-HTTPS fetches).

## Prerequisites

- Rust (stable)
- PostgreSQL 13+

## Setup

```bash
# 1. Create a database
createdb arterm_marketplace
# (or: psql -c "CREATE DATABASE arterm_marketplace;")

# 2. Configure
cp .env.example .env          # edit DATABASE_URL etc.
export $(grep -v '^#' .env | xargs)   # or use your own env loader

# 3. Run — migrations apply automatically on boot
cargo run
# → arterm-marketplace listening on 0.0.0.0:8787
```

The schema in `migrations/0001_init.sql` is applied on startup.

## API

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET`  | `/healthz` | — | liveness |
| `POST` | `/v1/publishers` | — | claim a namespace, get a publish token |
| `POST` | `/v1/extensions` | Bearer | publish a version (id must be in your namespace) |
| `GET`  | `/v1/registry` | — | the index the app polls |
| `GET`  | `/v1/extensions/:id` | — | detail + version history |
| `GET`  | `/v1/extensions/:id/manifest` | — | latest manifest JSON (install target) |
| `POST` | `/v1/extensions/:id/download` | — | record an install |

A publisher owns a **namespace**: every extension `id` must be
`"<publisher>.<name>"`. Publishing a version that already exists is rejected
(no silent overwrite); publishing to another publisher's id is forbidden.

## Publishing (end to end)

```bash
BASE=http://localhost:8787

# 1. Register a publisher — save the token, it is shown only once.
curl -s -X POST $BASE/v1/publishers \
  -H 'content-type: application/json' \
  -d '{"name":"acme"}'
# → {"name":"acme","token":"arterm_…"}

TOKEN=arterm_…   # paste the token from above

# 2. Publish an extension. The manifest is the full arterm-extension.json.
#    For an executable extension, inline the entry code as "mainSource"
#    (file-based packaging / .arterm-ext is a planned follow-up).
curl -s -X POST $BASE/v1/extensions \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{
        "manifest": {
          "id": "acme.hello",
          "name": "Hello",
          "version": "1.0.0",
          "description": "Adds a Hello command.",
          "permissions": [],
          "activationEvents": ["onCommand:hello.world"],
          "mainSource": "exports.activate=(c)=>{c.subscriptions.push(arterm.commands.registerCommand(\"hello.world\",()=>arterm.window.showInformationMessage(\"hi\")))};",
          "contributes": { "commands": [ { "command": "hello.world", "title": "Hello World" } ] }
        }
      }'
# → {"id":"acme.hello","version":"1.0.0","manifestUrl":"…/v1/extensions/acme.hello/manifest"}
```

## Pointing the Arterm app at your marketplace

In the app: **Settings → Marketplace → registry URL** →
`http://localhost:8787/v1/registry` (or your `PUBLIC_BASE_URL`), then **Save**.
The app lists your extensions and installs them via each entry's `manifestUrl`.

> `PUBLIC_BASE_URL` must be how the **app** reaches this server, since it is
> baked into the `manifestUrl` the app fetches. For LAN/remote use, set it to a
> reachable host (the app's installer enforces HTTPS for remote fetches).

## Roadmap (not yet implemented)

- `.arterm-ext` zip packages + object storage for multi-file extensions
  (today, executable extensions ship inline via `mainSource`).
- Ratings/reviews, download analytics, a web publisher dashboard.
- Package signing (reuse the app's minisign trust root).
