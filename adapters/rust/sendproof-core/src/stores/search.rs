//! Write classification for Elasticsearch and OpenSearch, driven by
//! `spec/data-stores/elasticsearch.json` (embedded in [`tables`](super::tables)). One table covers
//! both engines.
//!
//! The unit is the HTTP method and path. The table's endpoints are tried in order and the first match
//! decides; `GET` and `HEAD` read on every other path, and everything else is a write. Every function
//! here is pure; the shared vectors in `spec/data-stores/classification-cases.json` run through them
//! in this module's tests.

use std::{collections::HashSet, sync::OnceLock};

use serde_json::{Map, Value};

use super::{
    classify::CommandKind,
    cql::{Classified, Dialect, statement_shape},
    tables,
};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Read,
    Write,
    Session,
    /// A SQL endpoint: a read only when the body says so.
    Sql,
}

struct Endpoint {
    kind: Kind,
    name: String,
    methods: Vec<String>,
    paths: Vec<Vec<String>>,
}

struct Table {
    endpoints: Vec<Endpoint>,
    read_words: Vec<String>,
    method_default: Vec<(String, CommandKind)>,
}

fn kind_of(name: &str) -> CommandKind {
    match name {
        "read" => CommandKind::Read,
        "session" => CommandKind::Session,
        _ => CommandKind::Write,
    }
}

fn table() -> &'static Table {
    static TABLE: OnceLock<Table> = OnceLock::new();
    TABLE.get_or_init(|| {
        let table: Value = serde_json::from_str(tables::ELASTICSEARCH).expect("an embedded table is valid JSON");
        let strings = |value: &Value| -> Vec<String> {
            value.as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect()
        };
        let endpoints = table["endpoints"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|entry| Endpoint {
                kind: match entry["kind"].as_str().unwrap_or("write") {
                    "read" => Kind::Read,
                    "session" => Kind::Session,
                    "sql" => Kind::Sql,
                    _ => Kind::Write,
                },
                name: entry["name"].as_str().unwrap_or_default().to_owned(),
                methods: strings(&entry["methods"]),
                paths: strings(&entry["paths"]).iter().map(|path| segments(path)).collect(),
            })
            .collect();
        let method_default = table["methodDefault"]
            .as_object()
            .into_iter()
            .flatten()
            .map(|(method, kind)| (method.clone(), kind_of(kind.as_str().unwrap_or("write"))))
            .collect();
        Table { endpoints, read_words: strings(&table["sql"]["readWords"]), method_default }
    })
}

/// Decodes `%XX` escapes; text that isn't valid UTF-8 afterwards is kept as written.
fn percent_decode(segment: &str) -> String {
    let bytes = segment.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |at: usize| bytes.get(at).and_then(|byte| (*byte as char).to_digit(16));
        if bytes[i] == b'%' {
            if let (Some(high), Some(low)) = (hex(i + 1), hex(i + 2)) {
                out.push((high * 16 + low) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| segment.to_owned())
}

/// The decoded segments of a path: no query string, no repeated or trailing slashes, each segment
/// percent-decoded, as the server reads it.
fn segments(path: &str) -> Vec<String> {
    path.split('?').next().unwrap_or_default().split('/').filter(|segment| !segment.is_empty()).map(percent_decode).collect()
}

fn segment_matches(pattern: &str, segment: &str) -> bool {
    match pattern {
        "{index}" => !segment.is_empty() && !segment.starts_with('_'),
        "{id}" => !segment.is_empty(),
        literal => literal == segment,
    }
}

/// The first endpoint whose method (upper case) and one of whose paths match.
fn find(method: &str, parts: &[String]) -> Option<&'static Endpoint> {
    table().endpoints.iter().find(|entry| {
        entry.methods.iter().any(|candidate| candidate == method)
            && entry.paths.iter().any(|pattern| {
                pattern.len() == parts.len() && pattern.iter().zip(parts).all(|(pattern, segment)| segment_matches(pattern, segment))
            })
    })
}

/// Whether an SQL request only reads: the body's `query` is one `SELECT`, `SHOW`, `DESCRIBE` or `DESC`
/// statement, or it holds only a cursor (the next page of an earlier read). A query passed only in
/// the URL, an unreadable body, and every other statement are writes.
fn sql_reads(body: Option<&[u8]>) -> bool {
    let Some(Ok(Value::Object(body))) = body.map(serde_json::from_slice::<Value>) else { return false };
    match body.get("query") {
        Some(Value::String(query)) => {
            let shape = statement_shape(query, Dialect::SQL);
            !shape.broken && !shape.multiple && table().read_words.contains(&shape.first)
        }
        None => body.get("cursor").is_some_and(Value::is_string),
        Some(_) => false,
    }
}

/// Classifies an Elasticsearch or OpenSearch request by its method and path, and for the SQL
/// endpoints its body (`body` is the request body as sent). The operation is the table's endpoint
/// name, or for an unlisted path the method and path with every segment that doesn't start with an
/// underscore replaced by `{}`.
///
/// `treat_as_read` holds host-declared operation names, compared exactly, which turn a write into a
/// read.
pub fn classify_search(method: &str, path: &str, body: Option<&[u8]>, treat_as_read: Option<&HashSet<String>>) -> Classified {
    let method = method.to_ascii_uppercase();
    let parts = segments(path);
    let table = table();
    let (kind, operation) = match find(&method, &parts) {
        Some(entry) => {
            let kind = match entry.kind {
                Kind::Read => CommandKind::Read,
                Kind::Write => CommandKind::Write,
                Kind::Session => CommandKind::Session,
                Kind::Sql if sql_reads(body) => CommandKind::Read,
                Kind::Sql => CommandKind::Write,
            };
            (kind, entry.name.clone())
        }
        None => {
            let shown: Vec<&str> = parts.iter().map(|segment| if segment.starts_with('_') { segment.as_str() } else { "{}" }).collect();
            let kind = table.method_default.iter().find(|(name, _)| *name == method).map_or(CommandKind::Write, |(_, kind)| *kind);
            (kind, format!("{method} /{}", shown.join("/")))
        }
    };
    let kind =
        if kind == CommandKind::Write && treat_as_read.is_some_and(|reads| reads.contains(&operation)) { CommandKind::Read } else { kind };
    Classified { kind, operation }
}

/// Whether a request is an endpoint that needs its body to be classified (the SQL endpoints), so a
/// hook reads the body only when it has to.
pub fn search_needs_body(method: &str, path: &str) -> bool {
    find(&method.to_ascii_uppercase(), &segments(path)).is_some_and(|entry| entry.kind == Kind::Sql)
}

/// The index a request names (its first segment, when that isn't an endpoint), for
/// `db.collection.name`.
pub fn search_target(path: &str) -> Option<String> {
    segments(path).into_iter().next().filter(|first| !first.starts_with('_'))
}

/// Replaces every literal of a JSON value with `"?"`, keeping field names and operators.
fn sanitize_value(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(map.iter().map(|(name, inner)| (name.clone(), sanitize_value(inner))).collect::<Map<_, _>>()),
        Value::Array(items) => Value::Array(items.iter().map(sanitize_value).collect()),
        _ => Value::String("?".into()),
    }
}

/// A request body as a `Db` entry's statement: a JSON body keeps its field names and operators with
/// every literal replaced by `?`, and an NDJSON body (`_bulk`, `_msearch`) does the same one line per
/// line. A body that isn't JSON gives `None`: nothing of it is shown.
pub fn sanitize_search_body(body: &[u8]) -> Option<String> {
    if body.iter().all(u8::is_ascii_whitespace) {
        return None;
    }
    if let Ok(value) = serde_json::from_slice::<Value>(body) {
        return Some(sanitize_value(&value).to_string());
    }
    let lines: Option<Vec<String>> = std::str::from_utf8(body)
        .ok()?
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str::<Value>(line).ok().map(|value| sanitize_value(&value).to_string()))
        .collect();
    lines.map(|lines| lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cases() -> Value {
        serde_json::from_str(include_str!("../../../../../spec/data-stores/classification-cases.json")).unwrap()
    }

    /// The case's body as the client would send it: an object as JSON, an array as NDJSON, a string as is.
    fn body_of(case: &Value) -> Option<Vec<u8>> {
        match case.get("body")? {
            Value::String(text) => Some(text.clone().into_bytes()),
            Value::Array(lines) => Some(lines.iter().map(|line| line.to_string() + "\n").collect::<String>().into_bytes()),
            other => Some(other.to_string().into_bytes()),
        }
    }

    #[test]
    fn elasticsearch_passes_every_shared_vector() {
        let cases = cases();
        let cases = cases["elasticsearch"].as_array().unwrap();
        assert!(cases.len() >= 60, "the shared vectors were not loaded");
        for case in cases {
            let body = body_of(case);
            let got = classify_search(case["method"].as_str().unwrap(), case["path"].as_str().unwrap(), body.as_deref(), None);
            let expected = match case["expect"].as_str().unwrap() {
                "read" => CommandKind::Read,
                "write" => CommandKind::Write,
                "session" => CommandKind::Session,
                other => panic!("unknown expectation {other}"),
            };
            assert_eq!(got.kind, expected, "{case}");
            assert_eq!(got.operation, case["operation"].as_str().unwrap(), "{case}");
        }
    }

    #[test]
    fn unlisted_requests_follow_the_method() {
        assert_eq!(classify_search("get", "/anything/_future", None, None).kind, CommandKind::Read);
        assert_eq!(classify_search("PATCH", "/a/_doc/1", None, None).kind, CommandKind::Write);
        assert_eq!(classify_search("POST", "/a/_future", None, None).kind, CommandKind::Write);
    }

    #[test]
    fn host_declared_reads_are_exact_operation_names() {
        let reads: HashSet<String> = ["POST /{}/_future".to_owned()].into();
        assert_eq!(classify_search("POST", "/a/_future", None, Some(&reads)).kind, CommandKind::Read);
        assert_eq!(classify_search("POST", "/a/_future2", None, Some(&reads)).kind, CommandKind::Write);
        assert_eq!(classify_search("POST", "/_bulk", None, Some(&reads)).kind, CommandKind::Write);
    }

    #[test]
    fn only_the_sql_endpoints_need_the_body() {
        assert!(search_needs_body("POST", "/_plugins/_sql"));
        assert!(!search_needs_body("POST", "/a/_search"));
    }

    #[test]
    fn targets_name_the_index() {
        assert_eq!(search_target("/articles/_search?x=1").as_deref(), Some("articles"));
        assert_eq!(search_target("/_search"), None);
        assert_eq!(search_target("/"), None);
    }

    #[test]
    fn bodies_lose_their_values() {
        assert_eq!(
            sanitize_search_body(br#"{"query":{"ids":{"values":["seeded"]}},"size":1}"#).unwrap(),
            r#"{"query":{"ids":{"values":["?"]}},"size":"?"}"#
        );
        assert_eq!(
            sanitize_search_body(b"{\"index\":{\"_id\":\"a\"}}\n{\"title\":\"x\"}\n").unwrap(),
            "{\"index\":{\"_id\":\"?\"}}\n{\"title\":\"?\"}"
        );
        assert_eq!(sanitize_search_body(b"not json"), None);
        assert_eq!(sanitize_search_body(b"  "), None);
    }
}
