//! Write classification for Redis and DynamoDB, driven by the shared tables in `spec/data-stores/`
//! (embedded in [`tables`](super::tables)).
//!
//! Each table lists reads and connection-level commands; **everything else, including a command the
//! table has never heard of, is a write**, so the guard fails closed when a store adds a command.
//! Every function here is pure; the shared vectors in `spec/data-stores/classification-cases.json`
//! run through them in this module's tests.

use std::{collections::HashSet, sync::OnceLock};

use serde_json::Value;

use super::tables;

/// How the guard treats one store command. Only [`Write`](Self::Write) can block a Preview.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandKind {
    /// Runs normally and is logged.
    Read,
    /// Blocks a Preview.
    Write,
    /// A connection-level command (`AUTH`, `HELLO`, `PING`, `SELECT`, ...): allowed, never logged.
    Session,
    /// `MULTI`, `EXEC`, `DISCARD`, `WATCH`, `UNWATCH`: allowed, never logged; each queued command is
    /// classified on its own.
    Transaction,
}

/// The names in one list of a table, as a set.
fn names(table: &Value, list: &str) -> HashSet<String> {
    table[list].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect()
}

fn parse(text: &str) -> Value {
    serde_json::from_str(text).expect("an embedded table is valid JSON")
}

struct Redis {
    read: HashSet<String>,
    session: HashSet<String>,
    transaction: HashSet<String>,
}

fn redis() -> &'static Redis {
    static TABLE: OnceLock<Redis> = OnceLock::new();
    TABLE.get_or_init(|| {
        let table = parse(tables::REDIS);
        let mut read = names(&table, "read");
        read.extend(names(&table, "moduleRead"));
        Redis { read, session: names(&table, "session"), transaction: names(&table, "transaction") }
    })
}

/// Classifies a Redis command. `name` is the command name in any case, and `first_argument` the
/// first argument, which only forms `CONTAINER|SUBCOMMAND` keys such as `OBJECT|ENCODING`.
/// `treat_as_read` holds host-declared reads, compared exactly against the upper-case key.
pub fn classify_redis(name: &str, first_argument: Option<&[u8]>, treat_as_read: Option<&HashSet<String>>) -> CommandKind {
    let command = name.to_ascii_uppercase();
    let with_subcommand = first_argument.map(|first| format!("{command}|{}", String::from_utf8_lossy(first).to_ascii_uppercase()));
    let table = redis();
    for key in with_subcommand.iter().chain(std::iter::once(&command)) {
        if table.session.contains(key) {
            return CommandKind::Session;
        }
        if table.transaction.contains(key) {
            return CommandKind::Transaction;
        }
        if table.read.contains(key) || treat_as_read.is_some_and(|reads| reads.contains(key)) {
            return CommandKind::Read;
        }
    }
    CommandKind::Write
}

/// Skips whitespace and SQL-style comments, then returns the first word of a PartiQL statement in
/// upper case. An unterminated block comment, or text that doesn't start with a word, gives `""`.
pub fn partiql_verb(statement: &str) -> String {
    let mut text = statement;
    loop {
        let trimmed = text.trim_start();
        if let Some(comment) = trimmed.strip_prefix("--") {
            match comment.find('\n') {
                Some(end) => text = &comment[end + 1..],
                None => return String::new(),
            }
        } else if let Some(comment) = trimmed.strip_prefix("/*") {
            match comment.find("*/") {
                Some(end) => text = &comment[end + 2..],
                None => return String::new(),
            }
        } else {
            return trimmed.chars().take_while(char::is_ascii_alphabetic).collect::<String>().to_ascii_uppercase();
        }
    }
}

struct Dynamo {
    read: HashSet<String>,
    partiql: HashSet<String>,
}

fn dynamo() -> &'static Dynamo {
    static TABLE: OnceLock<Dynamo> = OnceLock::new();
    TABLE.get_or_init(|| {
        let table = parse(tables::DYNAMODB);
        Dynamo { read: names(&table, "read"), partiql: names(&table["partiql"], "operations") }
    })
}

/// Classifies a DynamoDB action as [`Read`](CommandKind::Read) or [`Write`](CommandKind::Write).
///
/// `statements` are the PartiQL statements of a PartiQL request (`ExecuteStatement`,
/// `BatchExecuteStatement`, `ExecuteTransaction`); such a request is a read only when every one is a
/// `SELECT`. Pass an empty slice when the input could not be read: it is then a write. `treat_as_read`
/// holds host-declared action names.
pub fn classify_dynamo(operation: &str, statements: &[&str], treat_as_read: Option<&HashSet<String>>) -> CommandKind {
    let table = dynamo();
    if table.read.contains(operation) || treat_as_read.is_some_and(|reads| reads.contains(operation)) {
        return CommandKind::Read;
    }
    if table.partiql.contains(operation) && !statements.is_empty() && statements.iter().all(|statement| partiql_verb(statement) == "SELECT") {
        return CommandKind::Read;
    }
    CommandKind::Write
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cases() -> Value {
        serde_json::from_str(include_str!("../../../../../spec/data-stores/classification-cases.json")).unwrap()
    }

    fn expected(case: &Value) -> CommandKind {
        match case["expect"].as_str().unwrap() {
            "read" => CommandKind::Read,
            "write" => CommandKind::Write,
            "session" => CommandKind::Session,
            "transaction" => CommandKind::Transaction,
            other => panic!("unknown expectation {other}"),
        }
    }

    #[test]
    fn redis_passes_every_shared_vector() {
        for case in cases()["redis"].as_array().unwrap() {
            let command: Vec<&str> = case["command"].as_array().unwrap().iter().map(|part| part.as_str().unwrap()).collect();
            let kind = classify_redis(command[0], command.get(1).map(|first| first.as_bytes()), None);
            assert_eq!(kind, expected(case), "{command:?}");
        }
    }

    #[test]
    fn dynamodb_passes_every_shared_vector() {
        for case in cases()["dynamodb"].as_array().unwrap() {
            let input = &case["input"];
            let statements: Vec<&str> = match (input["Statement"].as_str(), input["Statements"].as_array().or(input["TransactStatements"].as_array())) {
                (Some(statement), _) => vec![statement],
                (None, Some(list)) => list.iter().map(|item| item["Statement"].as_str().unwrap_or("")).collect(),
                (None, None) => Vec::new(),
            };
            let operation = case["operation"].as_str().unwrap();
            assert_eq!(classify_dynamo(operation, &statements, None), expected(case), "{operation} {input}");
        }
    }

    #[test]
    fn unknown_commands_are_writes() {
        assert_eq!(classify_redis("NEWCOMMAND", None, None), CommandKind::Write);
        assert_eq!(classify_dynamo("NewAction", &[], None), CommandKind::Write);
    }

    #[test]
    fn host_declared_reads_are_exact() {
        let reads: HashSet<String> = ["MYMODULE.GET".to_owned()].into();
        assert_eq!(classify_redis("mymodule.get", None, Some(&reads)), CommandKind::Read);
        assert_eq!(classify_redis("MYMODULE.GETX", None, Some(&reads)), CommandKind::Write);
        let actions: HashSet<String> = ["CustomRead".to_owned()].into();
        assert_eq!(classify_dynamo("CustomRead", &[], Some(&actions)), CommandKind::Read);
    }

    #[test]
    fn container_commands_use_their_subcommand() {
        assert_eq!(classify_redis("object", Some(b"encoding"), None), CommandKind::Read);
        assert_eq!(classify_redis("OBJECT", Some(b"FREQ"), None), CommandKind::Read);
        assert_eq!(classify_redis("CLIENT", Some(b"KILL"), None), CommandKind::Write);
    }

    #[test]
    fn partiql_skips_comments_and_whitespace() {
        assert_eq!(partiql_verb("  -- note\n /* block */ select * from t"), "SELECT");
        assert_eq!(partiql_verb("/* unterminated select"), "");
        assert_eq!(partiql_verb("-- only a comment"), "");
        assert_eq!(partiql_verb("DELETE FROM t"), "DELETE");
        assert_eq!(classify_dynamo("BatchExecuteStatement", &["SELECT 1", "UPDATE t SET a = 1"], None), CommandKind::Write);
        assert_eq!(classify_dynamo("ExecuteTransaction", &[], None), CommandKind::Write);
        assert_eq!(json!(partiql_verb("")), json!(""));
    }
}
