-- Arterm marketplace schema.
--
-- A publisher owns a namespace: every extension id must be "<publisher>.<name>".
-- Each extension has many versions; the manifest (including any inline
-- executable `mainSource`) is stored as JSONB so the registry can serve it
-- directly to the app.

CREATE TABLE IF NOT EXISTS publishers (
    id          UUID PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    token_hash  TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS extensions (
    id             TEXT PRIMARY KEY,                 -- "<publisher>.<name>"
    publisher_id   UUID NOT NULL REFERENCES publishers(id),
    name           TEXT NOT NULL,
    description    TEXT,
    author         TEXT,
    homepage       TEXT,
    tags           TEXT[] NOT NULL DEFAULT '{}',
    downloads      BIGINT NOT NULL DEFAULT 0,
    latest_version TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS extensions_publisher_idx ON extensions (publisher_id);

CREATE TABLE IF NOT EXISTS extension_versions (
    extension_id TEXT NOT NULL REFERENCES extensions(id),
    version      TEXT NOT NULL,
    manifest     JSONB NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (extension_id, version)
);
