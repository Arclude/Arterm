use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::Json;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth;
use crate::error::AppError;
use crate::models::{
    ExtensionRow, PublishRequest, RegisterPublisherRequest, RegisterPublisherResponse,
    RegistryEntry, RegistryIndex,
};
use crate::AppState;

/// `GET /healthz`
pub async fn health() -> &'static str {
    "ok"
}

/// `POST /v1/publishers` — claim a namespace and receive a publish token.
pub async fn register_publisher(
    State(state): State<AppState>,
    Json(req): Json<RegisterPublisherRequest>,
) -> Result<Json<RegisterPublisherResponse>, AppError> {
    let name = req.name.trim().to_lowercase();
    if !is_valid_namespace(&name) {
        return Err(AppError::BadRequest(
            "publisher name must be 2–39 chars of [a-z0-9-], starting alphanumeric".into(),
        ));
    }

    let exists: Option<(Uuid,)> = sqlx::query_as("SELECT id FROM publishers WHERE name = $1")
        .bind(&name)
        .fetch_optional(&state.pool)
        .await?;
    if exists.is_some() {
        return Err(AppError::Conflict(format!("publisher '{name}'")));
    }

    let token = auth::generate_token();
    let token_hash = auth::hash_token(&token);
    sqlx::query("INSERT INTO publishers (id, name, token_hash) VALUES ($1, $2, $3)")
        .bind(Uuid::new_v4())
        .bind(&name)
        .bind(&token_hash)
        .execute(&state.pool)
        .await?;

    Ok(Json(RegisterPublisherResponse { name, token }))
}

/// `POST /v1/extensions` — publish a version. Auth: `Bearer <publish token>`.
/// The extension id must live in the caller's namespace ("<publisher>.<name>").
pub async fn publish(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<PublishRequest>,
) -> Result<Json<Value>, AppError> {
    let publisher = auth::authenticate(&state.pool, &headers).await?;
    let m = &req.manifest;

    let id = str_field(m, "id")?;
    let name = str_field(m, "name")?;
    let version = str_field(m, "version")?;

    let prefix = format!("{}.", publisher.name);
    if !id.starts_with(&prefix) {
        return Err(AppError::Forbidden(format!(
            "id '{id}' must start with '{prefix}' (your namespace)"
        )));
    }

    let description = opt_str_field(m, "description");
    let author = opt_str_field(m, "author");
    let homepage = opt_str_field(m, "homepage");
    let tags: Vec<String> = m
        .get("tags")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|t| t.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    // Ownership: if the extension already exists it must belong to this caller.
    let owner: Option<(Uuid,)> =
        sqlx::query_as("SELECT publisher_id FROM extensions WHERE id = $1")
            .bind(&id)
            .fetch_optional(&state.pool)
            .await?;
    if let Some((owner_id,)) = owner {
        if owner_id != publisher.id {
            return Err(AppError::Forbidden(format!(
                "'{id}' is owned by another publisher"
            )));
        }
    }

    // Reject a duplicate version up front (idempotency / no silent overwrite).
    let dup: Option<(String,)> = sqlx::query_as(
        "SELECT version FROM extension_versions WHERE extension_id = $1 AND version = $2",
    )
    .bind(&id)
    .bind(&version)
    .fetch_optional(&state.pool)
    .await?;
    if dup.is_some() {
        return Err(AppError::Conflict(format!("{id}@{version}")));
    }

    sqlx::query(
        "INSERT INTO extensions \
         (id, publisher_id, name, description, author, homepage, tags, latest_version, updated_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now()) \
         ON CONFLICT (id) DO UPDATE SET \
           name = $3, description = $4, author = $5, homepage = $6, \
           tags = $7, latest_version = $8, updated_at = now()",
    )
    .bind(&id)
    .bind(publisher.id)
    .bind(&name)
    .bind(&description)
    .bind(&author)
    .bind(&homepage)
    .bind(&tags)
    .bind(&version)
    .execute(&state.pool)
    .await?;

    sqlx::query(
        "INSERT INTO extension_versions (extension_id, version, manifest) VALUES ($1, $2, $3)",
    )
    .bind(&id)
    .bind(&version)
    .bind(m.clone())
    .execute(&state.pool)
    .await?;

    Ok(Json(json!({
        "id": id,
        "version": version,
        "manifestUrl": state.manifest_url(&id),
    })))
}

/// `GET /v1/registry` — the index the Arterm app polls. Shape matches the app's
/// `RegistryEntry`, so the existing Marketplace UI consumes it directly.
pub async fn registry(State(state): State<AppState>) -> Result<Json<RegistryIndex>, AppError> {
    let rows: Vec<ExtensionRow> = sqlx::query_as(
        "SELECT id, name, description, author, homepage, tags, downloads, latest_version \
         FROM extensions ORDER BY downloads DESC, name ASC",
    )
    .fetch_all(&state.pool)
    .await?;

    let extensions = rows
        .into_iter()
        .map(|r| RegistryEntry {
            manifest_url: state.manifest_url(&r.id),
            id: r.id,
            name: r.name,
            version: r.latest_version,
            description: r.description,
            author: r.author,
            homepage: r.homepage,
            tags: r.tags,
            downloads: r.downloads,
        })
        .collect();

    Ok(Json(RegistryIndex {
        schema: 1,
        updated_at: chrono::Utc::now().to_rfc3339(),
        extensions,
    }))
}

/// `GET /v1/extensions/:id/manifest` — the latest manifest JSON (what install
/// fetches). Does not count as a download.
pub async fn manifest(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let manifest: Option<(Value,)> = sqlx::query_as(
        "SELECT ev.manifest FROM extension_versions ev \
         JOIN extensions e ON e.id = ev.extension_id AND e.latest_version = ev.version \
         WHERE ev.extension_id = $1",
    )
    .bind(&id)
    .fetch_optional(&state.pool)
    .await?;
    let (manifest,) = manifest.ok_or(AppError::NotFound)?;
    Ok(Json(manifest))
}

/// `POST /v1/extensions/:id/download` — record an install and return where to
/// fetch the manifest. Lets the app report installs without us guessing.
pub async fn download(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let updated = sqlx::query("UPDATE extensions SET downloads = downloads + 1 WHERE id = $1")
        .bind(&id)
        .execute(&state.pool)
        .await?;
    if updated.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "manifestUrl": state.manifest_url(&id) })))
}

/// `GET /v1/extensions/:id` — detail view with the full version list.
pub async fn detail(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let row: Option<ExtensionRow> = sqlx::query_as(
        "SELECT id, name, description, author, homepage, tags, downloads, latest_version \
         FROM extensions WHERE id = $1",
    )
    .bind(&id)
    .fetch_optional(&state.pool)
    .await?;
    let row = row.ok_or(AppError::NotFound)?;

    let versions: Vec<(String, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        "SELECT version, created_at FROM extension_versions \
         WHERE extension_id = $1 ORDER BY created_at DESC",
    )
    .bind(&id)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(json!({
        "id": row.id,
        "name": row.name,
        "description": row.description,
        "author": row.author,
        "homepage": row.homepage,
        "tags": row.tags,
        "downloads": row.downloads,
        "latestVersion": row.latest_version,
        "manifestUrl": state.manifest_url(&id),
        "versions": versions.into_iter()
            .map(|(v, t)| json!({ "version": v, "createdAt": t.to_rfc3339() }))
            .collect::<Vec<_>>(),
    })))
}

// ---- helpers -----------------------------------------------------------------

fn str_field(m: &Value, key: &str) -> Result<String, AppError> {
    m.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| AppError::BadRequest(format!("manifest.{key} is required")))
}

fn opt_str_field(m: &Value, key: &str) -> Option<String> {
    m.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
}

/// Namespace / publisher name rule: 2–39 chars, lowercase alphanumeric and
/// hyphen, must start with an alphanumeric.
fn is_valid_namespace(name: &str) -> bool {
    let len = name.len();
    if !(2..=39).contains(&len) {
        return false;
    }
    let mut chars = name.chars();
    let first = chars.next().unwrap();
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    name.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn namespace_rules() {
        assert!(is_valid_namespace("acme"));
        assert!(is_valid_namespace("acme-co"));
        assert!(is_valid_namespace("a1"));
        // too short / too long
        assert!(!is_valid_namespace("a"));
        assert!(!is_valid_namespace(&"a".repeat(40)));
        // must start alphanumeric, lowercase only, no spaces/symbols
        assert!(!is_valid_namespace("-acme"));
        assert!(!is_valid_namespace("Acme"));
        assert!(!is_valid_namespace("acme corp"));
        assert!(!is_valid_namespace("acme_co"));
    }

    #[test]
    fn str_field_requires_nonempty() {
        let m = serde_json::json!({ "id": "acme.demo", "blank": "  " });
        assert_eq!(str_field(&m, "id").unwrap(), "acme.demo");
        assert!(str_field(&m, "missing").is_err());
        assert!(str_field(&m, "blank").is_err());
    }
}
