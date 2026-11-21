//! The interceptor against an SDK client whose "network" is a recorder: what is sent is exactly what
//! the guard let through.

use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Instant,
};

use aws_credential_types::Credentials;
use aws_sdk_dynamodb::{Client, Config, config::Region, types::AttributeValue};
use aws_smithy_runtime::client::http::test_util::infallible_client_fn;
use aws_smithy_types::body::SdkBody;
use sendproof_core::capture::{self, Recorder};

use super::*;

/// A client that counts the requests that reach the "wire" and answers each with `reply`.
fn client(store: &DynamoStore, reply: &'static str) -> (Client, Arc<AtomicUsize>) {
    let sent = Arc::new(AtomicUsize::new(0));
    let counter = sent.clone();
    let http = infallible_client_fn(move |_| {
        counter.fetch_add(1, Ordering::SeqCst);
        http02::Response::builder().status(200).body(SdkBody::from(reply)).unwrap()
    });
    let config = Config::builder()
        .behavior_version_latest()
        .region(Region::new("us-east-1"))
        .credentials_provider(Credentials::for_tests())
        .http_client(http)
        .interceptor(store.interceptor())
        .build();
    (Client::from_conf(config), sent)
}

fn preview() -> Arc<Recorder> {
    let recorder = Recorder::new_preview(Instant::now(), true);
    recorder.begin(true);
    recorder
}

fn id(value: &str) -> AttributeValue {
    AttributeValue::S(value.to_owned())
}

#[tokio::test]
async fn a_read_runs_and_is_logged() {
    let (client, sent) = client(&DynamoStore::new(), r#"{"Item":{"id":{"S":"seeded"}}}"#);
    let recorder = preview();
    let output =
        capture::scope(recorder.clone(), async { client.get_item().table_name("orders").key("id", id("seeded")).send().await }).await;
    assert!(output.unwrap().item().is_some());
    assert_eq!(sent.load(Ordering::SeqCst), 1);
    assert!(recorder.blocked().is_none());
    let logs = recorder.finish().logs;
    let db = logs[0].db.as_ref().unwrap();
    assert_eq!((db.operation.as_str(), db.target.as_deref(), db.rows_affected, db.blocked), ("GetItem", Some("orders"), Some(1), false));
}

#[tokio::test]
async fn a_write_is_refused_before_it_is_sent_and_marks_the_preview() {
    let (client, sent) = client(&DynamoStore::new(), "{}");
    let recorder = preview();
    let result = capture::scope(recorder.clone(), async {
        client
            .update_item()
            .table_name("orders")
            .key("id", id("blocked"))
            .update_expression("ADD hits :one")
            .expression_attribute_values(":one", AttributeValue::N("1".into()))
            .send()
            .await
    })
    .await;
    assert!(result.is_err());
    assert_eq!(sent.load(Ordering::SeqCst), 0, "no request reached the wire");
    let blocked = recorder.blocked().expect("marked");
    assert_eq!((blocked.store.as_str(), blocked.operation.as_str()), ("dynamodb", "UpdateItem"));
    assert_eq!(blocked.detail, "Preview unavailable: this operation writes to DynamoDB");
    let logs = recorder.finish().logs;
    assert_eq!(logs.len(), 1, "a refused operation is logged once, as blocked");
    assert!(logs[0].db.as_ref().unwrap().blocked);
}

#[tokio::test]
async fn put_and_delete_are_writes_too() {
    let (client, sent) = client(&DynamoStore::new(), "{}");
    let recorder = preview();
    capture::scope(recorder.clone(), async {
        assert!(client.put_item().table_name("orders").item("id", id("a")).send().await.is_err());
        assert!(client.delete_item().table_name("orders").key("id", id("a")).send().await.is_err());
    })
    .await;
    assert_eq!(sent.load(Ordering::SeqCst), 0);
    assert_eq!(recorder.blocked().unwrap().operation, "PutItem", "the first write wins");
}

#[tokio::test]
async fn partiql_is_a_read_only_when_every_statement_selects() {
    let (client, sent) = client(&DynamoStore::new(), r#"{"Items":[]}"#);
    let recorder = preview();
    capture::scope(recorder.clone(), async {
        client.execute_statement().statement(r#"SELECT * FROM "orders" WHERE id = ?"#).parameters(id("a")).send().await.unwrap();
        let update = client
            .execute_statement()
            .statement(r#"UPDATE "orders" SET status = 'cancelled' WHERE id = ?"#)
            .parameters(id("a"))
            .send()
            .await;
        assert!(update.is_err());
    })
    .await;
    assert_eq!(sent.load(Ordering::SeqCst), 1, "only the SELECT was sent");
    assert_eq!(recorder.blocked().unwrap().operation, "ExecuteStatement");
}

#[tokio::test]
async fn inline_partiql_literals_never_reach_the_log() {
    let (client, _) = client(&DynamoStore::new(), r#"{"Items":[]}"#);
    let recorder = preview();
    capture::scope(recorder.clone(), async {
        client
            .execute_statement()
            .statement(r#"SELECT * FROM "orders" WHERE email = 'ann@example.test' AND id = 42"#)
            .send()
            .await
            .unwrap();
    })
    .await;
    let logs = recorder.finish().logs;
    let db = logs[0].db.as_ref().unwrap();
    assert_eq!(db.statement.as_deref(), Some(r#"SELECT * FROM "orders" WHERE email = ? AND id = ?"#));
    assert_eq!(db.target.as_deref(), Some("orders"));
    assert!(!serde_json::to_string(&logs).unwrap().contains("ann@example.test"));
}

#[tokio::test]
async fn writes_outside_a_preview_run_and_are_traced() {
    let (client, sent) = client(&DynamoStore::new(), r#"{"Attributes":{"id":{"S":"sent"}}}"#);
    // An ordinary Send: no capture at all.
    client.put_item().table_name("orders").item("id", id("a")).send().await.unwrap();
    // An observed Send: the write runs and is logged.
    let observed = Recorder::new(Instant::now(), true);
    observed.begin(false);
    capture::scope(observed.clone(), async { client.put_item().table_name("orders").item("id", id("b")).send().await.unwrap() }).await;
    assert_eq!(sent.load(Ordering::SeqCst), 2);
    assert!(observed.blocked().is_none());
    let logs = observed.finish().logs;
    assert_eq!(logs.iter().filter(|log| log.db.as_ref().is_some_and(|db| db.operation == "PutItem")).count(), 1);
}

/// Runs a Preview of `POST /things` through the core pipeline, with `store` registered.
async fn run_preview<F: std::future::Future<Output = ()>>(store: &DynamoStore, handler: F) -> sendproof_core::Reply {
    use sendproof_core::{Core, Headers, Inner, PreviewState};
    let config = sendproof_core::Config::builder("Test")
        .environment("Development")
        .enable_in(["Development"])
        .preview_operation("POST", "/things")
        .data_store(store.clone())
        .build()
        .unwrap();
    let core = Core::new(config);
    let state = PreviewState::new(&core, Instant::now());
    state.enroll(&core, "POST", Some("/things"), &Headers::new()).await.expect("enrolled");
    capture::scope(state.recorder(), handler).await;
    state.complete();
    state.finish(Ok(Inner { status: 200, headers: Headers::new(), body: b"{}".to_vec() })).await
}

#[tokio::test]
async fn an_unattributed_write_while_a_preview_is_open_fails_it() {
    let store = DynamoStore::new();
    let (client, sent) = client(&store, "{}");
    let reply = run_preview(&store, async {
        // A spawned task has no request scope: the write is sent, and nothing can say whose it was.
        tokio::spawn(async move { client.put_item().table_name("orders").item("id", id("a")).send().await.unwrap() }).await.unwrap();
    })
    .await;
    assert_eq!(sent.load(Ordering::SeqCst), 1);
    assert_eq!(reply.status, 500, "{}", String::from_utf8_lossy(&reply.body));
}

#[tokio::test]
async fn a_detached_background_write_leaves_an_open_preview_confirmable() {
    let store = DynamoStore::new();
    let (client, _) = client(&store, "{}");
    let reply = run_preview(&store, async {
        tokio::spawn(sendproof_core::detached(
            async move { client.put_item().table_name("orders").item("id", id("a")).send().await.unwrap() },
        ))
        .await
        .unwrap();
    })
    .await;
    assert_eq!(reply.status, 200, "{}", String::from_utf8_lossy(&reply.body));
}

#[tokio::test]
async fn a_host_declared_read_is_allowed_by_exact_name_only() {
    let store = DynamoStore::new().treat_as_read(["PutItem"]).unwrap();
    let (client, sent) = client(&store, "{}");
    let recorder = preview();
    capture::scope(recorder.clone(), async { client.put_item().table_name("orders").item("id", id("a")).send().await.unwrap() }).await;
    assert_eq!(sent.load(Ordering::SeqCst), 1);
    assert!(DynamoStore::new().treat_as_read(["Put*"]).is_err());
}

/// The negative test: a client built without the interceptor writes during a Preview, and the
/// Preview would be confirmed. This is what the conformance checks catch.
#[tokio::test]
async fn the_checks_fail_when_the_interceptor_is_missing() {
    let sent = Arc::new(AtomicUsize::new(0));
    let counter = sent.clone();
    let config = Config::builder()
        .behavior_version_latest()
        .region(Region::new("us-east-1"))
        .credentials_provider(Credentials::for_tests())
        .http_client(infallible_client_fn(move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
            http02::Response::builder().status(200).body(SdkBody::from("{}")).unwrap()
        }))
        .build();
    let recorder = preview();
    capture::scope(recorder.clone(), async {
        Client::from_conf(config).put_item().table_name("orders").item("id", id("a")).send().await.unwrap()
    })
    .await;
    assert_eq!(sent.load(Ordering::SeqCst), 1, "an unhooked client writes during a Preview");
    assert!(recorder.blocked().is_none());
}

#[tokio::test]
async fn credentials_and_signatures_never_reach_a_log() {
    let (client, _) = client(&DynamoStore::new(), r#"{"Item":{"id":{"S":"seeded"}}}"#);
    let recorder = preview();
    capture::scope(recorder.clone(), async { client.get_item().table_name("orders").key("id", id("seeded")).send().await.unwrap() }).await;
    let text = serde_json::to_string(&recorder.finish().logs).unwrap();
    for secret in ["AWS4-HMAC-SHA256", "Credential=", "Signature="] {
        assert!(!text.contains(secret), "{secret}");
    }
}

#[test]
fn a_label_that_looks_like_an_endpoint_is_refused() {
    assert!(DynamoStore::new().name("orders").is_ok());
    assert!(DynamoStore::new().name("http://127.0.0.1:8000").is_err());
}

/// The interceptor against the compose DynamoDB Local (`docker compose -f tests/conformance/compose.yml
/// up -d --wait dynamodb`): every write action is refused before it reaches the server, proven by an
/// independent client without the interceptor. Skips, saying why, when DynamoDB doesn't answer.
mod server {
    use std::time::Duration;

    use aws_sdk_dynamodb::types::{
        AttributeDefinition, BatchStatementRequest, BillingMode, ConditionCheck, KeySchemaElement, KeyType, ParameterizedStatement, Put,
        PutRequest, ScalarAttributeType, TransactWriteItem, WriteRequest,
    };

    use super::*;

    fn client(interceptor: Option<DynamoGuard>) -> Client {
        let endpoint = std::env::var("BENCH_DYNAMODB_SERVER_URL").unwrap_or_else(|_| "http://127.0.0.1:58000".into());
        let mut config = Config::builder()
            .behavior_version_latest()
            .endpoint_url(endpoint)
            .region(Region::new("us-east-1"))
            .credentials_provider(Credentials::for_tests());
        if let Some(interceptor) = interceptor {
            config = config.interceptor(interceptor);
        }
        Client::from_conf(config.build())
    }

    #[tokio::test]
    async fn no_write_action_reaches_the_server_during_a_preview() {
        let reader = client(None);
        if tokio::time::timeout(Duration::from_secs(3), reader.list_tables().send()).await.map_or(true, |result| result.is_err()) {
            eprintln!("skipped: DynamoDB isn't running (docker compose -f tests/conformance/compose.yml up -d --wait dynamodb)");
            return;
        }
        let table = format!(
            "sp_test_{}_{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        );
        reader
            .create_table()
            .table_name(&table)
            .attribute_definitions(
                AttributeDefinition::builder().attribute_name("id").attribute_type(ScalarAttributeType::S).build().unwrap(),
            )
            .key_schema(KeySchemaElement::builder().attribute_name("id").key_type(KeyType::Hash).build().unwrap())
            .billing_mode(BillingMode::PayPerRequest)
            .send()
            .await
            .unwrap();
        reader.put_item().table_name(&table).item("id", id("seeded")).item("hits", AttributeValue::N("1".into())).send().await.unwrap();

        let guarded = client(Some(DynamoStore::new().interceptor()));
        let recorder = preview();
        capture::scope(recorder.clone(), async {
            // Reads run.
            let item = guarded.get_item().table_name(&table).key("id", id("seeded")).consistent_read(true).send().await.unwrap();
            assert!(item.item().is_some());
            let select = format!("SELECT * FROM \"{table}\" WHERE id = ?");
            guarded.execute_statement().statement(&select).parameters(id("seeded")).send().await.unwrap();

            let put = |name: &str| PutRequest::builder().item("id", id(name)).build().unwrap();
            let refused = [
                guarded.put_item().table_name(&table).item("id", id("put")).send().await.is_err(),
                guarded
                    .update_item()
                    .table_name(&table)
                    .key("id", id("seeded"))
                    .update_expression("ADD hits :one")
                    .expression_attribute_values(":one", AttributeValue::N("1".into()))
                    .send()
                    .await
                    .is_err(),
                guarded.delete_item().table_name(&table).key("id", id("seeded")).send().await.is_err(),
                guarded
                    .batch_write_item()
                    .request_items(&table, vec![WriteRequest::builder().put_request(put("batched")).build()])
                    .send()
                    .await
                    .is_err(),
                guarded
                    .transact_write_items()
                    .transact_items(
                        TransactWriteItem::builder()
                            .put(Put::builder().table_name(&table).item("id", id("transacted")).build().unwrap())
                            .build(),
                    )
                    .send()
                    .await
                    .is_err(),
                // A transaction of condition checks only is still a write.
                guarded
                    .transact_write_items()
                    .transact_items(
                        TransactWriteItem::builder()
                            .condition_check(
                                ConditionCheck::builder()
                                    .table_name(&table)
                                    .key("id", id("seeded"))
                                    .condition_expression("attribute_exists(id)")
                                    .build()
                                    .unwrap(),
                            )
                            .build(),
                    )
                    .send()
                    .await
                    .is_err(),
                guarded.execute_statement().statement(format!("INSERT INTO \"{table}\" VALUE {{'id': 'partiql'}}")).send().await.is_err(),
                guarded
                    .batch_execute_statement()
                    .statements(BatchStatementRequest::builder().statement(&select).parameters(id("seeded")).build().unwrap())
                    .statements(
                        BatchStatementRequest::builder().statement(format!("DELETE FROM \"{table}\" WHERE id = 'seeded'")).build().unwrap(),
                    )
                    .send()
                    .await
                    .is_err(),
                guarded
                    .execute_transaction()
                    .transact_statements(
                        ParameterizedStatement::builder()
                            .statement(format!("UPDATE \"{table}\" SET hits = 9 WHERE id = 'seeded'"))
                            .build()
                            .unwrap(),
                    )
                    .send()
                    .await
                    .is_err(),
                guarded.delete_table().table_name(&table).send().await.is_err(),
            ];
            assert!(refused.iter().all(|refused| *refused), "every write is refused: {refused:?}");
        })
        .await;
        assert_eq!(recorder.blocked().unwrap().operation, "PutItem", "the first write is the one reported");

        // An independent read, through a client without the interceptor: the table holds only what was
        // seeded, unchanged.
        let items = reader.scan().table_name(&table).consistent_read(true).send().await.unwrap();
        let ids: Vec<&str> = items.items().iter().filter_map(|item| item.get("id")?.as_s().ok().map(String::as_str)).collect();
        assert_eq!(ids, ["seeded"]);
        assert_eq!(items.items()[0].get("hits").and_then(|hits| hits.as_n().ok()).map(String::as_str), Some("1"));
        reader.delete_table().table_name(&table).send().await.unwrap();
    }
}
