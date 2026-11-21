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
