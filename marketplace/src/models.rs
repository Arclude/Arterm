use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// A publisher row (owns a namespace). The token hash is matched in SQL, so it
/// is not selected into this struct.
#[derive(Debug, sqlx::FromRow)]
pub struct Publisher {
    pub id: Uuid,
    pub name: String,
}

/// An extension row, joined with whatever the list/detail views need.
#[derive(Debug, sqlx::FromRow)]
pub struct ExtensionRow {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub author: Option<String>,
    pub homepage: Option<String>,
    pub tags: Vec<String>,
    pub downloads: i64,
    pub latest_version: String,
}

// ---- request bodies ----------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct RegisterPublisherRequest {
    pub name: String,
}

#[derive(Debug, Serialize)]
pub struct RegisterPublisherResponse {
    pub name: String,
    /// The bearer token to use for publishing. Shown ONCE; only its hash is
    /// stored. Treat it like a password.
    pub token: String,
}

#[derive(Debug, Deserialize)]
pub struct PublishRequest {
    /// The full `artex-extension.json` as a JSON object. `id`, `name`, and
    /// `version` are required; `id` must start with "<publisher>.".
    pub manifest: serde_json::Value,
}

// ---- registry / response shapes ----------------------------------------------

/// One entry in the registry index. Shape matches the Artex app's
/// `RegistryEntry` so the existing Marketplace UI consumes it unchanged.
#[derive(Debug, Serialize)]
pub struct RegistryEntry {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(rename = "manifestUrl")]
    pub manifest_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    pub tags: Vec<String>,
    /// Extra field the app ignores but a dashboard can use.
    pub downloads: i64,
}

/// The registry index document served at `GET /v1/registry`.
#[derive(Debug, Serialize)]
pub struct RegistryIndex {
    pub schema: u32,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    pub extensions: Vec<RegistryEntry>,
}
