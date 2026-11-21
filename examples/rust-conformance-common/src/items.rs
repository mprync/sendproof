//! The fixture's operations, independent of any web framework.

use std::sync::{Arc, Mutex};

use sendproof_core::capture::{self, EmailEffect};
use sendproof_sqlx::{Backend, Db, DbConn, DbError, RowsAffected};
use serde_json::{Value, json};

/// What an operation answers with.
pub struct Outcome {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: Option<Value>,
}

impl Outcome {
    pub fn new(status: u16, body: Value) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: Some(body),
        }
    }

    pub fn empty(status: u16) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: None,
        }
    }

    pub fn problem(status: u16, title: &str) -> Self {
        Self::new(status, json!({ "title": title, "status": status }))
    }
}

/// The emails the fixture "delivered". Suppressed during a preview.
#[derive(Clone, Default)]
pub struct Outbox(Arc<Mutex<Vec<String>>>);

impl Outbox {
    fn send(&self, description: &str, email: &EmailEffect) {
        // `true` means the host must suppress delivery (a preview).
        if !capture::record_email(description, email) {
            self.0.lock().unwrap().push(email.subject.clone());
        }
    }
}

/// Inserts an item; `false` when it already exists.
pub async fn insert<B: Backend>(db: &Db<B>, id: &str, name: &str) -> Result<bool, DbError> {
    let mut conn = db.acquire().await?;
    match conn
        .query("INSERT INTO items (id, name) VALUES (:id, :name)")
        .bind("id", id)
        .bind("name", name)
        .execute()
        .await
    {
        Ok(_) => Ok(true),
        Err(DbError::Sqlx(sqlx::Error::Database(error))) if error.is_unique_violation() => {
            Ok(false)
        }
        Err(error) => Err(error),
    }
}

/// `POST /items`.
pub async fn create<B: Backend>(
    db: &Db<B>,
    outbox: &Outbox,
    body: &Value,
) -> Result<Outcome, DbError> {
    let text = |field: &str| {
        body.get(field)
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
    };
    let (Some(id), Some(name)) = (text("id"), text("name")) else {
        return Ok(Outcome::problem(400, "An item needs an id and a name."));
    };
    if !insert(db, id, name).await? {
        return Ok(Outcome::problem(409, "The item already exists."));
    }
    // A bound parameter whose name looks secret, to exercise redaction.
    let mut conn = db.acquire().await?;
    conn.query("SELECT :fixture_secret AS echoed")
        .bind("fixture_secret", "fixture-secret-value")
        .fetch_optional()
        .await?;
    drop(conn);
    tracing::info!("created:{id}");
    let email = EmailEffect {
        from: "bench@example.test".into(),
        to: vec!["stock@example.test".into()],
        subject: format!("Created {id}"),
        text: format!("Item {id} was created."),
        ..EmailEffect::default()
    };
    outbox.send("Created item", &email);
    Ok(Outcome::new(201, json!({ "id": id, "name": name })))
}

/// `GET /items/{id}`.
pub async fn read<B: Backend>(db: &Db<B>, id: &str) -> Result<Outcome, DbError>
where
    String: for<'r> sqlx::Decode<'r, B> + sqlx::Type<B>,
    usize: sqlx::ColumnIndex<B::Row>,
{
    let mut conn = db.acquire().await?;
    let name = conn
        .query("SELECT name FROM items WHERE id = :id")
        .bind("id", id)
        .fetch_scalar::<String>()
        .await?;
    Ok(match name {
        Some(name) => Outcome::new(200, json!({ "id": id, "name": name })),
        None => Outcome::empty(404),
    })
}

/// `PATCH /items/{id}`; copies the `tag` query parameter to `X-Fixture-Tag`.
pub async fn rename<B: Backend>(
    db: &Db<B>,
    id: &str,
    name: &str,
    tag: Option<&str>,
) -> Result<Outcome, DbError> {
    let mut conn = db.acquire().await?;
    let result = conn
        .query("UPDATE items SET name = :name WHERE id = :id")
        .bind("name", name)
        .bind("id", id)
        .execute()
        .await?;
    if result.rows_affected() == 0 {
        return Ok(Outcome::empty(404));
    }
    let mut outcome = Outcome::new(200, json!({ "id": id, "name": name }));
    if let Some(tag) = tag {
        outcome.headers.push(("x-fixture-tag", tag.to_owned()));
    }
    Ok(outcome)
}

/// `DELETE /items/{id}`.
pub async fn delete<B: Backend>(db: &Db<B>, id: &str) -> Result<Outcome, DbError> {
    let mut conn = db.acquire().await?;
    let result = conn
        .query("DELETE FROM items WHERE id = :id")
        .bind("id", id)
        .execute()
        .await?;
    Ok(Outcome::empty(if result.rows_affected() == 0 {
        404
    } else {
        204
    }))
}

/// `POST /items/{id}/fail`: inserts, then fails with a handled 409.
pub async fn fail<B: Backend>(db: &Db<B>, id: &str) -> Result<Outcome, DbError> {
    insert(db, id, "Will fail").await?;
    Ok(Outcome::problem(409, "The operation failed after writing."))
}

/// `POST /items/{id}/large`: inserts, then answers with a body over the preview cap.
pub async fn large<B: Backend>(db: &Db<B>, id: &str) -> Result<Outcome, DbError> {
    insert(db, id, "Large").await?;
    Ok(Outcome::new(
        200,
        json!({ "padding": "x".repeat(1024 * 1024 + 1024) }),
    ))
}

/// `POST /items/{id}/redirect`: inserts, then redirects with an inner cookie that must never leak.
pub async fn redirect<B: Backend>(db: &Db<B>, id: &str, base: &str) -> Result<Outcome, DbError> {
    insert(db, id, "Redirected").await?;
    let mut outcome = Outcome::empty(302);
    outcome
        .headers
        .push(("location", format!("{base}/items/{id}")));
    outcome
        .headers
        .push(("set-cookie", "inner=1; Path=/".into()));
    Ok(outcome)
}

/// `POST /items/{id}/capture`: many changes, effects and logs in one request.
pub async fn capture_many<B: Backend>(
    db: &Db<B>,
    outbox: &Outbox,
    id: &str,
) -> Result<Outcome, DbError> {
    for index in 0..210 {
        insert(db, &format!("{id}-{index}"), "Bulk").await?;
    }
    for index in 0..110 {
        outbox.send(
            "Bulk notice",
            &EmailEffect {
                subject: format!("Bulk {index}"),
                ..EmailEffect::default()
            },
        );
    }
    for index in 0..510 {
        tracing::info!("bulk log {index}");
    }
    Ok(Outcome::new(200, Value::Null))
}

/// `POST /items/{id}/ordinary`: Send only, never declared for preview.
pub async fn ordinary<B: Backend>(db: &Db<B>, id: &str) -> Result<Outcome, DbError> {
    insert(db, id, "Ordinary").await?;
    Ok(Outcome::new(201, json!({ "id": id, "name": "Ordinary" })))
}

/// `POST /accounts`: stores the password as the literal `hashed:<password>` (test data, so the runner can
/// search captures for it). Used by the `secret-columns` shared rule.
pub async fn create_account<B: Backend>(db: &Db<B>, body: &Value) -> Result<Outcome, DbError> {
    let text = |field: &str| {
        body.get(field)
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
    };
    let (Some(id), Some(email), Some(password)) = (text("id"), text("email"), text("password"))
    else {
        return Ok(Outcome::problem(
            400,
            "An account needs an id, an email and a password.",
        ));
    };
    let mut conn = db.acquire().await?;
    conn.query(
        "INSERT INTO accounts (id, email, password_hash) VALUES (:id, :email, :password_hash)",
    )
    .bind("id", id)
    .bind("email", email)
    .bind("password_hash", format!("hashed:{password}").as_str())
    .execute()
    .await?;
    Ok(Outcome::new(201, json!({ "id": id, "email": email })))
}

/// `GET /accounts/{id}`.
pub async fn read_account<B: Backend>(db: &Db<B>, id: &str) -> Result<Outcome, DbError>
where
    String: for<'r> sqlx::Decode<'r, B> + sqlx::Type<B>,
    usize: sqlx::ColumnIndex<B::Row>,
{
    let mut conn = db.acquire().await?;
    let email = conn
        .query("SELECT email FROM accounts WHERE id = :id")
        .bind("id", id)
        .fetch_scalar::<String>()
        .await?;
    Ok(match email {
        Some(email) => Outcome::new(200, json!({ "id": id, "email": email })),
        None => Outcome::empty(404),
    })
}

/// Executes a `COMMIT` through plain SQLx (`raw_sql`) on the connection the handler uses, rather than
/// through a named query. In a preview the connection refuses it before it is sent. Implemented for
/// each SQLx backend.
pub trait RawCommit: Backend {
    fn raw_commit(conn: &mut DbConn<Self>) -> sendproof_core::BoxFuture<'_, ()>;
}

macro_rules! raw_commit {
    ($backend:ty) => {
        impl RawCommit for $backend {
            fn raw_commit(conn: &mut DbConn<Self>) -> sendproof_core::BoxFuture<'_, ()> {
                Box::pin(async move {
                    // The error is the point: a preview refuses the commit, and the handler carries on.
                    let _ = sqlx::raw_sql("COMMIT").execute(conn).await;
                })
            }
        }
    };
}
raw_commit!(sqlx::Sqlite);
raw_commit!(sqlx::Postgres);
raw_commit!(sqlx::MySql);

/// `POST /items/{id}/escape` (the `mysql-escape` shared rule, MySQL only): inserts the item, then on the
/// same connection runs, by `via`, `CREATE TABLE sendproof_escape_<id> (n INT)` (an implicit commit) or
/// `CALL sendproof_commit_probe()` (a procedure that commits), ignoring the refusal as a careless handler
/// would, and answers 201. A Preview must answer 500 with nothing kept.
pub async fn escape<B: Backend>(db: &Db<B>, id: &str, body: &Value) -> Result<Outcome, DbError> {
    if B::SYSTEM != "mysql" {
        return Ok(Outcome::empty(404));
    }
    let Some(name) = body
        .get("name")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
    else {
        return Ok(Outcome::problem(400, "An item needs a name."));
    };
    let statement = match body.get("via").and_then(Value::as_str) {
        Some("ddl")
            if !id.is_empty()
                && id.len() <= 40
                && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') =>
        {
            format!("CREATE TABLE sendproof_escape_{id} (n INT)")
        }
        Some("call") => "CALL sendproof_commit_probe()".to_owned(),
        _ => {
            return Ok(Outcome::problem(
                400,
                "`via` must be \"ddl\" or \"call\", with a word id.",
            ));
        }
    };
    insert(db, id, name).await?;
    let mut conn = db.acquire().await?;
    let _ = conn.query(&statement).execute().await;
    drop(conn);
    Ok(Outcome::new(201, json!({ "id": id, "name": name })))
}

/// `POST /items/{id}/commit`: inserts the item, then executes a raw `COMMIT` on the same connection and
/// answers 201. Used by the `raw-commit` shared rule: a Preview must answer 500 without confirming.
pub async fn commit<B: RawCommit>(db: &Db<B>, id: &str, body: &Value) -> Result<Outcome, DbError> {
    let Some(name) = body
        .get("name")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
    else {
        return Ok(Outcome::problem(400, "An item needs a name."));
    };
    insert(db, id, name).await?;
    let mut conn = db.acquire().await?;
    B::raw_commit(&mut conn).await;
    drop(conn);
    Ok(Outcome::new(201, json!({ "id": id, "name": name })))
}
