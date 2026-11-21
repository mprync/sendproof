//! Write classification for MongoDB command documents, driven by the shared table
//! `spec/data-stores/mongodb.json` (embedded in [`sendproof_core::stores::tables`]).
//!
//! The reads are `find`, `aggregate` without a writing stage, `count`, `distinct`, `getMore`,
//! `killCursors`, the `list*` commands and the statistics commands. **Everything else, including a
//! command the table has never heard of, is a write.** A document is classified by its first key,
//! case-insensitively, so this works on ordered BSON documents.

use std::{collections::HashSet, sync::OnceLock};

use mongodb::bson::{Bson, Document};
use sendproof_core::stores::{CommandKind, tables};

/// The result of classifying one command document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Classification {
    /// `Read`, `Write` or `Session`; never `Transaction`.
    pub kind: CommandKind,
    /// The command or aggregation stage MongoDB refuses inside a transaction, such as `$out`, which a
    /// `preview`-mode Preview must block before sending.
    pub refused_in_transaction: Option<String>,
}

struct Table {
    read: HashSet<String>,
    session: HashSet<String>,
    not_in_transaction: HashSet<String>,
    /// Aggregation stages MongoDB refuses inside a transaction, in table order.
    stages: Vec<String>,
}

fn table() -> &'static Table {
    static TABLE: OnceLock<Table> = OnceLock::new();
    TABLE.get_or_init(|| {
        let table: serde_json::Value = serde_json::from_str(tables::MONGODB).expect("the embedded table is valid JSON");
        let lower = |list: &serde_json::Value| -> HashSet<String> {
            list.as_array().into_iter().flatten().filter_map(|name| name.as_str()).map(str::to_lowercase).collect()
        };
        Table {
            read: lower(&table["read"]),
            session: lower(&table["session"]),
            not_in_transaction: lower(&table["notInTransaction"]["commands"]),
            stages: table["notInTransaction"]["stages"].as_array().into_iter().flatten().filter_map(|stage| stage.as_str()).map(str::to_owned).collect(),
        }
    })
}

/// Whether any key of an aggregation pipeline, at any depth (sub-pipelines in `$facet`, `$lookup`
/// and `$unionWith` included), is one of `stages`.
fn pipeline_uses(value: &Bson, stages: &[&str]) -> bool {
    match value {
        Bson::Array(items) => items.iter().any(|item| pipeline_uses(item, stages)),
        Bson::Document(document) => document.iter().any(|(key, inner)| stages.contains(&key.as_str()) || pipeline_uses(inner, stages)),
        _ => false,
    }
}

/// The command name: the first key of the document.
pub fn command_name(command: &Document) -> &str {
    command.keys().next().map_or("", String::as_str)
}

/// Classifies a command document. `aggregate` is a write when any stage at any depth is `$out` or
/// `$merge`; `explain` takes the classification of the command inside it. `treat_as_read` holds
/// host-declared reads in lower case.
pub fn classify_mongo(command: &Document, treat_as_read: Option<&HashSet<String>>) -> Classification {
    let name = command_name(command);
    let lower = name.to_lowercase();
    if lower == "explain" && let Some(Bson::Document(inner)) = command.get(name) {
        return classify_mongo(inner, treat_as_read);
    }
    let table = table();
    let mut refused = table.not_in_transaction.contains(&lower).then(|| name.to_owned());
    let pipeline = command.get("pipeline");
    if lower == "aggregate" && let Some(pipeline) = pipeline {
        let found = table.stages.iter().find(|stage| pipeline_uses(pipeline, &[stage.as_str()]));
        refused = found.cloned().or(refused);
    }
    let with_refusal = |kind| Classification { kind, refused_in_transaction: refused.clone() };
    if table.session.contains(&lower) {
        return Classification { kind: CommandKind::Session, refused_in_transaction: None };
    }
    if lower == "aggregate" && pipeline.is_some_and(|pipeline| pipeline_uses(pipeline, &["$out", "$merge"])) {
        return with_refusal(CommandKind::Write);
    }
    if table.read.contains(&lower) || treat_as_read.is_some_and(|reads| reads.contains(&lower)) {
        return with_refusal(CommandKind::Read);
    }
    with_refusal(CommandKind::Write)
}

#[cfg(test)]
mod tests {
    use mongodb::bson::doc;

    use super::*;

    #[test]
    fn passes_every_shared_vector() {
        // Parsed with BSON, not serde_json's map, so the first key of a command stays first.
        let text = include_str!("../../../../spec/data-stores/classification-cases.json");
        let cases: Document = serde_json::from_str(text).unwrap();
        for case in cases.get_array("mongodb").unwrap() {
            let case = case.as_document().unwrap();
            let command = case.get_document("command").unwrap();
            let result = classify_mongo(command, None);
            let expected = match case.get_str("expect").unwrap() {
                "read" => CommandKind::Read,
                "write" => CommandKind::Write,
                "session" => CommandKind::Session,
                other => panic!("unknown expectation {other}"),
            };
            assert_eq!(result.kind, expected, "{command}");
            assert_eq!(result.refused_in_transaction.as_deref(), case.get_str("refusedInTransaction").ok(), "{command}");
        }
    }

    #[test]
    fn a_stage_at_any_depth_makes_an_aggregate_a_write() {
        let nested = doc! { "aggregate": "c", "pipeline": [{ "$facet": { "a": [{ "$match": {} }, { "$out": "o" }] } }] };
        assert_eq!(classify_mongo(&nested, None).kind, CommandKind::Write);
        let union = doc! { "aggregate": "c", "pipeline": [{ "$unionWith": { "coll": "x", "pipeline": [{ "$merge": { "into": "y" } }] } }] };
        assert_eq!(classify_mongo(&union, None).kind, CommandKind::Write);
        let plain = doc! { "aggregate": "c", "pipeline": [{ "$match": { "a": 1 } }] };
        assert_eq!(classify_mongo(&plain, None).kind, CommandKind::Read);
    }

    #[test]
    fn explain_takes_the_inner_classification() {
        assert_eq!(classify_mongo(&doc! { "explain": { "find": "c" } }, None).kind, CommandKind::Read);
        assert_eq!(classify_mongo(&doc! { "explain": { "update": "c" } }, None).kind, CommandKind::Write);
    }

    #[test]
    fn the_command_name_is_the_first_key_in_any_case() {
        assert_eq!(classify_mongo(&doc! { "FIND": "c" }, None).kind, CommandKind::Read);
        assert_eq!(classify_mongo(&doc! { "findAndModify": "c" }, None).kind, CommandKind::Write);
        assert_eq!(classify_mongo(&doc! { "frobnicate": 1 }, None).kind, CommandKind::Write);
    }

    #[test]
    fn host_declared_reads_are_exact() {
        let reads: HashSet<String> = ["customread".to_owned()].into();
        assert_eq!(classify_mongo(&doc! { "customRead": 1 }, Some(&reads)).kind, CommandKind::Read);
        assert_eq!(classify_mongo(&doc! { "customReadX": 1 }, Some(&reads)).kind, CommandKind::Write);
    }
}
