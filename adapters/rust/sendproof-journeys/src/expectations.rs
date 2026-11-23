use serde_json::{Map, Value, json};
use time::Date;

/// A store operation the journey runner compares with the captured changes or database logs.
pub struct WriteExpectation {
    pub(super) document: Value,
    pub(super) approvals: Vec<(String, ApprovedDifference)>,
}

impl WriteExpectation {
    /// A SQL table (SQLite, PostgreSQL, MySQL) or the target of a database log from a guard-only store.
    pub fn table(store: &str, table: &str, op: &str) -> Self {
        Self::new(json!({ "store": store, "table": table, "op": op }))
    }

    pub fn mongo(collection: &str, op: &str) -> Self {
        Self::new(json!({ "store": "mongodb", "collection": collection, "op": op }))
    }

    pub fn redis(key: impl Into<Value>, op: &str) -> Self {
        Self::new(json!({ "store": "redis", "key": key.into(), "op": op.to_ascii_uppercase() }))
    }

    fn new(document: Value) -> Self {
        Self { document, approvals: Vec::new() }
    }

    /// Identifies a SQL row or MongoDB document by its captured key fields.
    pub fn row_key(mut self, key: impl IntoIterator<Item = (impl Into<String>, Value)>) -> Self {
        self.document["key"] = Value::Object(key.into_iter().map(|(name, value)| (name.into(), value)).collect::<Map<_, _>>());
        self
    }

    pub fn field(mut self, name: &str, value: impl Into<Value>) -> Self {
        self.document["values"][name] = value.into();
        self
    }

    /// Relaxes one field expectation. Its expected value and target come from this write.
    pub fn approve(mut self, field: &str, difference: ApprovedDifference) -> Self {
        self.approvals.push((field.into(), difference));
        self
    }
}

/// Matchers recognized by the journey runner.
pub struct Match;

impl Match {
    pub fn any(kind: &str) -> Value {
        json!({ "type": kind })
    }

    pub fn pattern(pattern: &str) -> Value {
        json!({ "pattern": pattern })
    }

    pub fn changed(from: impl Into<Value>, to: impl Into<Value>) -> Value {
        json!({ "from": from.into(), "to": to.into() })
    }
}

/// A reviewed variation of the actual value for a single expected field.
pub struct ApprovedDifference {
    pub id: String,
    pub actual: Value,
    pub reason: String,
    pub approved_by: String,
    pub approved_on: Date,
    pub expires: Option<Date>,
    pub link: Option<String>,
}
