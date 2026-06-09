use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

/// Every handler returns `Result<T, AppError>`; this maps cleanly to a JSON
/// error body with the right status code.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    BadRequest(String),
    #[error("unauthorized")]
    Unauthorized,
    #[error("forbidden: {0}")]
    Forbidden(String),
    #[error("not found")]
    NotFound,
    #[error("{0} already exists")]
    Conflict(String),
    #[error("database error")]
    Db(#[from] sqlx::Error),
}

impl AppError {
    fn status(&self) -> StatusCode {
        match self {
            AppError::BadRequest(_) => StatusCode::BAD_REQUEST,
            AppError::Unauthorized => StatusCode::UNAUTHORIZED,
            AppError::Forbidden(_) => StatusCode::FORBIDDEN,
            AppError::NotFound => StatusCode::NOT_FOUND,
            AppError::Conflict(_) => StatusCode::CONFLICT,
            AppError::Db(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = self.status();
        if status == StatusCode::INTERNAL_SERVER_ERROR {
            tracing::error!("request failed: {self:?}");
        }
        (status, Json(json!({ "error": self.to_string() }))).into_response()
    }
}
