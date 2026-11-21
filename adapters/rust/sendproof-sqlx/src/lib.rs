//! SQLx data layer for [Sendproof](https://github.com/mprync/sendproof).
//!
//! [`SqlxProvider`] enrolls a whole operation in one transaction on the connection the handler
//! uses, captures the row changes it makes, and rolls the transaction back. It supports SQLite
//! (feature `sqlite`, on by default), PostgreSQL (feature `postgres`) and MySQL (feature `mysql`):
//!
//! | Backend | Provider | Row changes |
//! | --- | --- | --- |
//! | SQLite | [`SqliteProvider`] | Pre-update hook: every row, including trigger and bulk writes |
//! | PostgreSQL | [`PgProvider`] | Row triggers that call a session-temporary function: every row, including trigger and bulk writes |
//! | MySQL | [`MySqlProvider`] | Primary-key-scoped before/after reads around single-table statements run through [`DbConn::query`] |
//!
//! Handlers reach the connection through [`Db`]:
//!
//! ```ignore
//! async fn create(db: Db, Json(item): Json<Item>) -> Result<StatusCode, DbError> {
//!     let mut conn = db.acquire().await?;
//!     conn.query("INSERT INTO items (id, name) VALUES (:id, :name)")
//!         .bind("id", &item.id)
//!         .bind("name", &item.name)
//!         .execute()
//!         .await?;
//!     Ok(StatusCode::CREATED)
//! }
//! ```
//!
//! `Db` is `Db<Sqlite>`; use `Db<Postgres>` or `Db<MySql>` for the other backends. Outside a
//! preview, `Db` hands out an ordinary pooled connection, so the same handler serves Send,
//! Observed Send and Preview.
//!
//! # Scope
//!
//! A preview uses **one** connection: acquire it once per request and do not hold two at a time.
//! Use [`DbConn::query`] for named SQL parameters, which are reported (and redacted) in the
//! capture, and [`DbConn::begin`] for nested transactions whose rolled-back changes are dropped
//! from the capture. The crate README lists what each backend captures and what it cannot.

mod backend;
mod db;
mod log;
mod provider;
mod query;

#[cfg(feature = "mysql")]
mod mysql;
#[cfg(feature = "postgres")]
mod postgres;
#[cfg(feature = "sqlite")]
mod sqlite;

pub use backend::{Backend, RowsAffected};
pub use db::{Db, DbConn, DbError, DbTransaction};
#[cfg(feature = "mysql")]
pub use provider::MySqlProvider;
#[cfg(feature = "postgres")]
pub use provider::PgProvider;
#[cfg(feature = "sqlite")]
pub use provider::SqliteProvider;
pub use provider::SqlxProvider;
pub use query::{NamedQuery, SqlValue};
