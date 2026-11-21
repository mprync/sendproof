//! Database and Sendproof configuration shared by the fixtures.

use std::{path::PathBuf, sync::Arc, time::Duration};

use sqlx::{
    MySqlPool, PgPool, Pool, SqlitePool,
    mysql::MySqlPoolOptions,
    postgres::PgPoolOptions,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};
use sendproof_core::{Config, ConfigBuilder};
use sendproof_sqlx::{Backend, SqlxProvider};

use crate::{
    auth::Sessions,
    scenario::{FailingRollback, Scenario},
    stores::Stores,
};

/// The operations declared for preview. `/items/{id}/ordinary` is deliberately absent.
pub const PREVIEW_OPERATIONS: [(&str, &str); 10] = [
    ("POST", "/items"),
    ("PATCH", "/items/{id}"),
    ("DELETE", "/items/{id}"),
    ("POST", "/items/{id}/fail"),
    ("POST", "/items/{id}/large"),
    ("POST", "/items/{id}/redirect"),
    ("POST", "/items/{id}/capture"),
    // The shared security rules (`spec/conformance/fixture.md`).
    ("POST", "/accounts"),
    ("POST", "/items/{id}/commit"),
    // `mysql-escape`; the route answers 404 on other databases.
    ("POST", "/items/{id}/escape"),
];

/// The fixture's database, chosen by `BENCH_DATABASE` (`sqlite`, the default, `postgresql` or
/// `mysql`). PostgreSQL and MySQL connect to `BENCH_DATABASE_URL`, a fresh disposable database
/// that the runner provides. SQLite uses its own file in the temp directory. Either way the fixture
/// creates its `items` table itself.
pub enum Database {
    Sqlite { pool: SqlitePool, file: PathBuf },
    Postgres(PgPool),
    MySql(MySqlPool),
}

impl Database {
    /// Connects to the database `BENCH_DATABASE` names and creates the `items` table.
    pub async fn open() -> Result<Self, Box<dyn std::error::Error>> {
        let kind = std::env::var("BENCH_DATABASE").unwrap_or_else(|_| "sqlite".into());
        let url = || {
            std::env::var("BENCH_DATABASE_URL")
                .map_err(|_| format!("BENCH_DATABASE={kind} needs BENCH_DATABASE_URL"))
        };
        Ok(match kind.as_str() {
            "sqlite" => {
                let file = std::env::temp_dir()
                    .join(format!("sendproof-rust-fixture-{}.db", std::process::id()));
                remove(&file);
                let options = SqliteConnectOptions::new()
                    .filename(&file)
                    .create_if_missing(true)
                    .journal_mode(SqliteJournalMode::Wal)
                    .busy_timeout(Duration::from_secs(5));
                // SQLite has one writer at a time. Extra connections only wait on its lock by polling with sleeps,
                // so load tests may set `BENCH_SQLITE_CONNECTIONS=1` to queue writers fairly in the pool instead.
                let connections = std::env::var("BENCH_SQLITE_CONNECTIONS")
                    .ok()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(8);
                let pool = SqlitePoolOptions::new()
                    .max_connections(connections)
                    .connect_with(options)
                    .await?;
                sqlx::query(
                    "CREATE TABLE items (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL)",
                )
                .execute(&pool)
                .await?;
                sqlx::query("CREATE TABLE accounts (id TEXT PRIMARY KEY NOT NULL, email TEXT NOT NULL, password_hash TEXT NOT NULL)")
                    .execute(&pool)
                    .await?;
                Self::Sqlite { pool, file }
            }
            "postgresql" | "postgres" => {
                let pool = PgPoolOptions::new()
                    .max_connections(8)
                    .connect(&url()?)
                    .await?;
                sqlx::query(
                    "CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, name TEXT NOT NULL)",
                )
                .execute(&pool)
                .await?;
                sqlx::query("CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL, password_hash TEXT NOT NULL)")
                    .execute(&pool)
                    .await?;
                Self::Postgres(pool)
            }
            "mysql" => {
                let pool = MySqlPoolOptions::new()
                    .max_connections(8)
                    .connect(&url()?)
                    .await?;
                sqlx::query("CREATE TABLE IF NOT EXISTS items (id VARCHAR(191) PRIMARY KEY, name TEXT NOT NULL) ENGINE=InnoDB")
                    .execute(&pool)
                    .await?;
                sqlx::query("CREATE TABLE IF NOT EXISTS accounts (id VARCHAR(191) PRIMARY KEY, email VARCHAR(191) NOT NULL, password_hash TEXT NOT NULL) ENGINE=InnoDB")
                    .execute(&pool)
                    .await?;
                // The `mysql-escape` shared rule (spec/conformance/fixture.md): a procedure that commits. The
                // provider declares no procedure safe. CREATE PROCEDURE needs the text protocol.
                sqlx::raw_sql("CREATE PROCEDURE IF NOT EXISTS sendproof_commit_probe() BEGIN COMMIT; END")
                    .execute(&pool)
                    .await?;
                Self::MySql(pool)
            }
            other => {
                return Err(format!(
                    "unknown BENCH_DATABASE `{other}` (use sqlite, postgresql or mysql)"
                )
                .into());
            }
        })
    }

    /// The label shown in the workbench: never a path or connection string.
    pub fn label(&self) -> &'static str {
        match self {
            Self::Sqlite { .. } => "fixture.db",
            Self::Postgres(_) => "fixture (PostgreSQL)",
            Self::MySql(_) => "fixture (MySQL)",
        }
    }

    /// Releases the database: SQLite removes its file; the runner owns the server databases.
    pub async fn close(self) {
        match self {
            Self::Sqlite { pool, file } => {
                pool.close().await;
                remove(&file);
            }
            Self::Postgres(pool) => pool.close().await,
            Self::MySql(pool) => pool.close().await,
        }
    }
}

fn remove(file: &std::path::Path) {
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", file.display()));
    }
}

/// The Sendproof configuration of the fixture for a scenario.
pub fn config<B: Backend>(
    scenario: Scenario,
    base: &str,
    pool: Pool<B>,
    label: &str,
    sessions: Arc<Sessions>,
    stores: &Stores,
) -> Result<Config, sendproof_core::ConfigError> {
    let mut config: ConfigBuilder = Config::builder("Sendproof Conformance")
        .environment(if scenario == Scenario::Disabled {
            "Production"
        } else {
            "Development"
        })
        .enable_in(["Development"])
        .path_base(base)
        .open_api_url("/openapi.json")
        .auth_provider("Password", "cookie", Some("/auth/sign-in"))
        .auth_provider("Personas", "personas", Some("/auth/personas"))
        .trace_retention(Duration::from_secs(5))
        .identity(move |headers| {
            let sessions = sessions.clone();
            async move { sessions.identity(&headers) }
        });
    for (method, path) in PREVIEW_OPERATIONS {
        config = config.preview_operation(method, path);
    }
    // The data stores the runner provisioned (none unless the entry lists `stores`).
    config = stores.configure(config);
    let provider = SqlxProvider::new(pool).database(label);
    config = match scenario {
        Scenario::NoProvider => config,
        Scenario::RollbackFailure => config.provider(FailingRollback(provider)),
        _ => config.provider(provider),
    };
    config.build()
}
