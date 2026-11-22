//! The Axum conformance fixture, described in `spec/conformance/fixture.md`.
//! Configure it with `PORT`, `BENCH_PATH_BASE`, `BENCH_SCENARIO`, `BENCH_DATABASE` (`sqlite`, the
//! default, `postgresql` or `mysql`) and, for a server database, `BENCH_DATABASE_URL`.

mod app;

use std::net::SocketAddr;

use rust_conformance_common::{scenario::Scenario, setup::Database, stores::Stores};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(5361);
    let base = std::env::var("BENCH_PATH_BASE").unwrap_or_default();
    let scenario =
        Scenario::parse(&std::env::var("BENCH_SCENARIO").unwrap_or_else(|_| "standard".into()))?;

    // Copy the events of preview and observed requests into their capture.
    tracing_subscriber::registry()
        .with(sendproof_core::SendproofLayer::new())
        .init();

    let database = Database::open().await?;
    let label = database.label();
    // MongoDB, Redis and DynamoDB are hooked only when the runner provisions them.
    let stores = Stores::from_env().await?;
    let router = match &database {
        Database::Sqlite { pool, .. } => app::build(pool.clone(), label, &base, scenario, stores)?,
        Database::Postgres(pool) => app::build(pool.clone(), label, &base, scenario, stores)?,
        Database::MySql(pool) => app::build(pool.clone(), label, &base, scenario, stores)?,
    };
    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).await?;
    eprintln!(
        "rust-conformance (axum, {label}) listening on http://127.0.0.1:{port}{base} ({scenario:?})"
    );
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown())
        .await?;
    database.close().await;
    Ok(())
}

async fn shutdown() {
    // SIGTERM exists only on Unix; on Windows the fixture stops on Ctrl+C or when its process tree is killed.
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = terminate => {}
    }
}
