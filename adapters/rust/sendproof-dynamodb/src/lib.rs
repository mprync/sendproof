//! DynamoDB write guard for [Sendproof](https://github.com/mprync/sendproof) (`spec/data-stores.md`, `guard` mode).
//!
//! DynamoDB can't roll back, so a Preview reads normally and is stopped **before the first write is
//! sent**. [`DynamoStore::interceptor`] returns an AWS SDK [`Intercept`] implementation: add it to the
//! client's configuration and every operation of that client is classified before it is signed or
//! transmitted, so credentials, the `Authorization` header and signatures never reach the guard.
//!
//! ```no_run
//! # fn demo() {
//! use sendproof_dynamodb::DynamoStore;
//!
//! let store = DynamoStore::new().name("orders").expect("a display label");
//! let config = aws_sdk_dynamodb::Config::builder()
//!     .behavior_version_latest()
//!     .region(aws_sdk_dynamodb::config::Region::new("us-east-1"))
//!     .interceptor(store.interceptor())
//!     .build();
//! let client = aws_sdk_dynamodb::Client::from_conf(config);
//! // Register it: Config::builder("Inventory").data_store(store)
//! # let _ = client;
//! # }
//! ```
//!
//! In a Preview, reads (`GetItem`, `Query`, `Scan`, `BatchGetItem`, `TransactGetItems`, `Describe*`,
//! `List*`) run and become `Db` log entries. The first write (`PutItem`, `UpdateItem`, `DeleteItem`,
//! `BatchWriteItem`, `TransactWriteItems`, a PartiQL statement that isn't a `SELECT`, and any action the
//! shared table doesn't list) is refused with an SDK error and marks the Preview blocked, which then
//! answers 409 whatever the handler does with the error.
//!
//! # Coverage
//!
//! Only clients built with the interceptor are covered. A client created without it, in another
//! process, or through a raw HTTP call is not guarded and not logged. The interceptor finds the
//! Preview through the request's task-local capture, so an SDK call made from a task the handler spawns
//! (which does not inherit it) is not covered either: await the call in the handler.

mod sanitize;

use std::{collections::HashSet, sync::Arc, time::Instant};

use aws_sdk_dynamodb::{
    config::{ConfigBag, Intercept, RuntimeComponents, interceptors::{BeforeTransmitInterceptorContextRef, FinalizerInterceptorContextRef}},
    operation::{
        delete_item::DeleteItemOutput, execute_statement::ExecuteStatementOutput, get_item::GetItemOutput, put_item::PutItemOutput,
        query::QueryOutput, scan::ScanOutput, update_item::UpdateItemOutput,
    },
};
use aws_smithy_runtime_api::box_error::BoxError;
use aws_smithy_types::config_bag::{Storable, StoreReplace};
use sendproof_core::{
    BoxFuture, CommandKind, ConfigError, DataStore, DbEntry, StoreDescription, StoreMode, StoreScope,
    stores::{classify_dynamo, exact_names, store_label},
};
use serde_json::Value;

pub use sanitize::sanitize_partiql;

/// The store id used in capabilities, `Db` entries and the blocked response.
pub const SYSTEM: &str = "dynamodb";

struct Settings {
    name: Option<String>,
    reads: HashSet<String>,
}

/// A hooked DynamoDB, ready for [`ConfigBuilder::data_store`](sendproof_core::ConfigBuilder::data_store).
///
/// Cheap to clone.
#[derive(Clone)]
pub struct DynamoStore {
    settings: Arc<Settings>,
}

impl Default for DynamoStore {
    fn default() -> Self {
        Self::new()
    }
}

impl DynamoStore {
    /// A DynamoDB store with no display label and no host-declared reads.
    pub fn new() -> Self {
        Self { settings: Arc::new(Settings { name: None, reads: HashSet::new() }) }
    }

    /// The display label shown in capabilities, such as `orders`. A label that looks like an endpoint,
    /// ARN or connection string is refused: discovery is visible to anyone who can open the workbench.
    pub fn name(self, label: &str) -> Result<Self, ConfigError> {
        let name = store_label(label)?;
        Ok(Self { settings: Arc::new(Settings { name: Some(name), reads: self.settings.reads.clone() }) })
    }

    /// Action names the host states never write, matched exactly (`"MyCustomRead"`).
    ///
    /// **This is the host's statement that the action never writes.** An action wrongly listed here is
    /// not blocked in a Preview.
    pub fn treat_as_read<I, S>(self, names: I) -> Result<Self, ConfigError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let reads = exact_names(names, str::to_owned)?;
        Ok(Self { settings: Arc::new(Settings { name: self.settings.name.clone(), reads }) })
    }

    /// The interceptor to add to the DynamoDB client's configuration with
    /// `aws_sdk_dynamodb::config::Builder::interceptor`.
    pub fn interceptor(&self) -> DynamoGuard {
        DynamoGuard { settings: self.settings.clone() }
    }
}

impl DataStore for DynamoStore {
    fn describe(&self) -> BoxFuture<'_, StoreDescription> {
        let name = self.settings.name.clone();
        Box::pin(async move { StoreDescription { system: SYSTEM.into(), name, mode: StoreMode::Guard, reason: None } })
    }
}

/// The AWS SDK interceptor that classifies each operation before it is signed or sent. See
/// [`DynamoStore::interceptor`].
#[derive(Clone)]
pub struct DynamoGuard {
    settings: Arc<Settings>,
}

impl std::fmt::Debug for DynamoGuard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DynamoGuard").finish_non_exhaustive()
    }
}

/// What the guard noted about the operation in flight, kept in the SDK's per-operation state until
/// the operation finishes and can be logged.
#[derive(Debug)]
struct Pending {
    operation: String,
    target: Option<String>,
    statement: Option<String>,
    started: Instant,
    /// The guard refused it and logged that itself.
    refused: bool,
}

impl Storable for Pending {
    type Storer = StoreReplace<Self>;
}

/// The action name from the `X-Amz-Target` header (`DynamoDB_20120810.UpdateItem`).
fn operation_of(request: &aws_smithy_runtime_api::http::Request) -> String {
    request.headers().get("x-amz-target").and_then(|target| target.rsplit('.').next()).unwrap_or_default().to_owned()
}

/// The PartiQL statements of a request body: `Statement`, or each entry of `Statements` and
/// `TransactStatements`.
fn statements_of(body: &Value) -> Vec<String> {
    if let Some(statement) = body.get("Statement").and_then(Value::as_str) {
        return vec![statement.to_owned()];
    }
    ["Statements", "TransactStatements"]
        .iter()
        .filter_map(|list| body.get(*list).and_then(Value::as_array))
        .flatten()
        .map(|item| item.get("Statement").and_then(Value::as_str).unwrap_or("").to_owned())
        .collect()
}

/// The table a request targets: `TableName`, the first `RequestItems` table, or the quoted PartiQL table.
fn target_of(body: &Value, statement: Option<&str>) -> Option<String> {
    if let Some(table) = body.get("TableName").and_then(Value::as_str) {
        return Some(table.to_owned());
    }
    if let Some(table) = body.get("RequestItems").and_then(Value::as_object).and_then(|items| items.keys().next()) {
        return Some(table.clone());
    }
    let statement = statement?;
    let start = statement.find('"')? + 1;
    let end = statement[start..].find('"')?;
    Some(statement[start..start + end].to_owned())
}

/// Items matched, returned or written, when the output says so.
fn rows_of(context: &FinalizerInterceptorContextRef<'_>) -> Option<u64> {
    let Some(Ok(output)) = context.output_or_error() else { return None };
    if let Some(output) = output.downcast_ref::<GetItemOutput>() {
        return output.item().map(|_| 1);
    }
    if let Some(output) = output.downcast_ref::<QueryOutput>() {
        return Some(output.count().max(0) as u64);
    }
    if let Some(output) = output.downcast_ref::<ScanOutput>() {
        return Some(output.count().max(0) as u64);
    }
    if let Some(output) = output.downcast_ref::<ExecuteStatementOutput>() {
        return Some(output.items().len() as u64);
    }
    if let Some(output) = output.downcast_ref::<UpdateItemOutput>() {
        return output.attributes().map(|_| 1);
    }
    if let Some(output) = output.downcast_ref::<PutItemOutput>() {
        return output.attributes().map(|_| 1);
    }
    output.downcast_ref::<DeleteItemOutput>().and_then(|output| output.attributes()).map(|_| 1)
}

/// The error name of a failed operation: the service's own type from `X-Amzn-Errortype`, else `Error`.
fn error_of(context: &FinalizerInterceptorContextRef<'_>) -> Option<String> {
    let Some(Err(_)) = context.output_or_error() else { return None };
    let name = context
        .response()
        .and_then(|response| response.headers().get("x-amzn-errortype"))
        .map(|kind| kind.split(['#', ':']).find(|part| !part.is_empty() && !part.contains('.')).unwrap_or(kind).to_owned());
    Some(name.unwrap_or_else(|| "Error".to_owned()))
}

impl Intercept for DynamoGuard {
    fn name(&self) -> &'static str {
        "SendproofDynamoDbGuard"
    }

    /// Runs after the request is serialized and before it is signed or transmitted: the earliest point
    /// that sees the whole request, including a PartiQL statement.
    fn read_after_serialization(
        &self,
        context: &BeforeTransmitInterceptorContextRef<'_>,
        _: &RuntimeComponents,
        cfg: &mut ConfigBag,
    ) -> Result<(), BoxError> {
        let request = context.request();
        let operation = operation_of(request);
        // An unreadable body leaves no statements, which classifies a PartiQL request as a write.
        let body: Value = request.body().bytes().and_then(|bytes| serde_json::from_slice(bytes).ok()).unwrap_or(Value::Null);
        let statements = statements_of(&body);
        let borrowed: Vec<&str> = statements.iter().map(String::as_str).collect();
        let kind: CommandKind = classify_dynamo(&operation, &borrowed, Some(&self.settings.reads));

        let statement = (!statements.is_empty()).then(|| statements.iter().map(|text| sanitize_partiql(text)).collect::<Vec<_>>().join("; "));
        let target = target_of(&body, statement.as_deref());
        let mut pending = Pending { operation: operation.clone(), target, statement, started: Instant::now(), refused: false };
        if let Err(blocked) = StoreScope::current().guard(SYSTEM, &operation, kind, None) {
            pending.refused = true;
            cfg.interceptor_state().store_put(pending);
            return Err(Box::new(blocked));
        }
        cfg.interceptor_state().store_put(pending);
        Ok(())
    }

    /// Logs the operation once it finished, successfully or not.
    fn read_after_execution(&self, context: &FinalizerInterceptorContextRef<'_>, _: &RuntimeComponents, cfg: &mut ConfigBag) -> Result<(), BoxError> {
        let Some(pending) = cfg.load::<Pending>() else { return Ok(()) };
        if pending.refused {
            return Ok(());
        }
        StoreScope::current().log(DbEntry {
            system: SYSTEM.into(),
            operation: pending.operation.clone(),
            target: pending.target.clone(),
            statement: pending.statement.clone(),
            rows_affected: rows_of(context),
            error: error_of(context),
            elapsed: pending.started.elapsed(),
            ..DbEntry::default()
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests;
