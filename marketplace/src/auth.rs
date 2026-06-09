use axum::http::{header::AUTHORIZATION, HeaderMap};
use sha2::{Digest, Sha256};
use sqlx::PgPool;

use crate::error::AppError;
use crate::models::Publisher;

/// Mint a new opaque publisher token. Returned to the publisher once; only its
/// hash is persisted.
pub fn generate_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("artex_{}", hex::encode(bytes))
}

/// SHA-256 of a token, hex-encoded. We store/compare hashes, never the token.
pub fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(hasher.finalize())
}

/// Resolve the publisher identified by the `Authorization: Bearer <token>`
/// header, or fail with 401.
pub async fn authenticate(pool: &PgPool, headers: &HeaderMap) -> Result<Publisher, AppError> {
    let raw = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or(AppError::Unauthorized)?;
    let token = raw
        .strip_prefix("Bearer ")
        .ok_or(AppError::Unauthorized)?
        .trim();
    if token.is_empty() {
        return Err(AppError::Unauthorized);
    }
    let hash = hash_token(token);
    sqlx::query_as::<_, Publisher>("SELECT id, name FROM publishers WHERE token_hash = $1")
        .bind(&hash)
        .fetch_optional(pool)
        .await?
        .ok_or(AppError::Unauthorized)
}
