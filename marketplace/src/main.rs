//! Artex marketplace — a small Axum + Postgres service that publishers push
//! extensions to and the Artex app installs from.
//!
//! The `GET /v1/registry` response intentionally matches the app's existing
//! `RegistryEntry` shape, so pointing the app's Marketplace registry URL at
//! `<this server>/v1/registry` is all the wiring required on the client.

mod auth;
mod error;
mod models;
mod routes;

use std::env;

use axum::routing::{get, post};
use axum::Router;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

/// Shared, cheaply-cloned handler state.
#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    /// Public base URL used to build absolute `manifestUrl`s.
    pub public_base_url: String,
}

impl AppState {
    /// Absolute URL the app fetches an extension's latest manifest from.
    pub fn manifest_url(&self, id: &str) -> String {
        format!("{}/v1/extensions/{}/manifest", self.public_base_url, id)
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,artex_marketplace=debug".into()),
        )
        .init();

    let database_url =
        env::var("DATABASE_URL").map_err(|_| "DATABASE_URL is required (see .env.example)")?;
    let bind_addr = env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8787".into());
    let public_base_url = env::var("PUBLIC_BASE_URL")
        .unwrap_or_else(|_| "http://localhost:8787".into())
        .trim_end_matches('/')
        .to_string();

    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(&database_url)
        .await?;

    // Apply migrations embedded at compile time from ./migrations.
    sqlx::migrate!("./migrations").run(&pool).await?;

    let state = AppState {
        pool,
        public_base_url,
    };

    let app = Router::new()
        .route("/healthz", get(routes::health))
        .route("/v1/publishers", post(routes::register_publisher))
        .route("/v1/extensions", post(routes::publish))
        .route("/v1/registry", get(routes::registry))
        .route("/v1/extensions/:id", get(routes::detail))
        .route("/v1/extensions/:id/manifest", get(routes::manifest))
        .route("/v1/extensions/:id/download", post(routes::download))
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&bind_addr).await?;
    tracing::info!("artex-marketplace listening on {bind_addr}");
    axum::serve(listener, app).await?;
    Ok(())
}
