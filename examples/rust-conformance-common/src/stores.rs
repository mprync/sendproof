//! The data-store routes of the fixture (`spec/conformance/fixture.md`, "Data store routes").
//!
//! Each store is hooked only when the runner passes its variables, so the standard and alternate
//! scenarios run without any store service. The routes use the clients exactly as an application
//! would: MongoDB through the guarded `Mongo` handle, Redis through a guarded connection, DynamoDB
//! through a client built with the interceptor, Cassandra through the guarded `scylla` session and
//! OpenSearch through the guarded client's raw `send`. Framework-neutral: the Axum and Actix
//! fixtures call these with the handles their extractors produce.

use std::{
    net::{SocketAddr, ToSocketAddrs},
    sync::Arc,
    time::Duration,
};

use aws_credential_types::Credentials;
use aws_sdk_dynamodb::{Client as DynamoClient, config::Region, types::AttributeValue};
use mongodb::{
    bson::{Bson, Document, doc},
    options::ClientOptions,
};
use opensearch::http::{Method, headers::HeaderMap, request::JsonBody, transport::Transport};
use scylla::{
    client::session_builder::SessionBuilder,
    errors::TranslationError,
    policies::address_translator::{AddressTranslator, UntranslatedPeer},
    statement::{batch::Batch, prepared::PreparedStatement},
};
use sendproof_cassandra::{Cassandra, CassandraStore};
use sendproof_core::{ConfigBuilder, capture};
use sendproof_dynamodb::DynamoStore;
use sendproof_elasticsearch::{OpenSearch, OpenSearchStore};
use sendproof_mongodb::{Mongo, MongoStore};
use sendproof_redis::{Redis, RedisStore};
use serde_json::{Value, json};
use tokio::sync::OnceCell;

use crate::items::Outcome;

/// A hooked Redis. The store owns the connection, so handlers only ever get a guarded one.
pub struct RedisFixture {
    pub store: RedisStore,
}

/// A hooked DynamoDB client and the table the runner created.
pub struct DynamoFixture {
    pub store: DynamoStore,
    pub client: DynamoClient,
    pub table: String,
}

/// A hooked Cassandra. The store owns the session, so handlers only ever get a guarded one.
pub struct CassandraFixture {
    pub store: CassandraStore,
    /// `SELECT id, status, hits FROM tickets WHERE id = ?`, prepared once.
    select: OnceCell<PreparedStatement>,
}

/// A hooked OpenSearch and the index the runner created. The store owns the client.
pub struct OpenSearchFixture {
    pub store: OpenSearchStore,
    pub index: String,
}

/// The stores the runner provisioned for this fixture process.
#[derive(Default)]
pub struct Stores {
    pub mongo: Option<MongoStore>,
    pub redis: Option<RedisFixture>,
    pub dynamo: Option<DynamoFixture>,
    pub cassandra: Option<CassandraFixture>,
    pub opensearch: Option<OpenSearchFixture>,
    /// The fresh key prefix every Redis key starts with.
    pub prefix: String,
}

/// The per-request store handles `remember` may write through, as the framework's extractors made them.
#[derive(Default)]
pub struct Handles<'a> {
    pub redis: Option<&'a Redis>,
    pub cassandra: Option<&'a Cassandra>,
    pub opensearch: Option<&'a OpenSearch>,
}

/// A single published Cassandra node. The node advertises its own address (a container IP, which a
/// host outside Docker can't reach), so every peer the driver learns of is the contact point.
struct Published(SocketAddr);

#[async_trait::async_trait]
impl AddressTranslator for Published {
    async fn translate_address(&self, _: &UntranslatedPeer) -> Result<SocketAddr, TranslationError> {
        Ok(self.0)
    }
}

/// An id as one URL path segment: everything but letters, digits and `-_.~` is percent-encoded.
fn segment(id: &str) -> String {
    id.bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (byte as char).to_string(),
            other => format!("%{other:02X}"),
        })
        .collect()
}

fn text(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty() && text.len() <= 150)
}

fn failed(error: impl std::fmt::Display) -> Outcome {
    // The detail is the store's own error: a refusal names the command, never a value.
    Outcome::problem(500, &error.to_string())
}

impl Stores {
    /// Connects to the stores whose variables are set.
    pub async fn from_env() -> Result<Self, Box<dyn std::error::Error>> {
        let env = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
        let mut stores = Self {
            prefix: env("BENCH_REDIS_PREFIX").unwrap_or_default(),
            ..Self::default()
        };
        if let Some(url) = env("BENCH_MONGODB_URL") {
            let options = ClientOptions::parse(&url).await?;
            let database = options
                .default_database
                .clone()
                .unwrap_or_else(|| "test".into());
            stores.mongo = Some(
                MongoStore::builder(options, database)
                    .name("catalog")?
                    .build()?,
            );
        }
        if let Some(url) = env("BENCH_REDIS_URL") {
            let connection = redis::Client::open(url)?
                .get_multiplexed_async_connection()
                .await?;
            stores.redis = Some(RedisFixture {
                store: RedisStore::new().connection(connection).name("cache")?,
            });
        }
        if let (Some(endpoint), Some(table)) =
            (env("BENCH_DYNAMODB_URL"), env("BENCH_DYNAMODB_TABLE"))
        {
            let store = DynamoStore::new().name("orders")?;
            let credentials = Credentials::new(
                env("AWS_ACCESS_KEY_ID").unwrap_or_default(),
                env("AWS_SECRET_ACCESS_KEY").unwrap_or_default(),
                None,
                None,
                "fixture",
            );
            let config = aws_sdk_dynamodb::Config::builder()
                .behavior_version_latest()
                .endpoint_url(endpoint)
                .region(Region::new(
                    env("AWS_REGION").unwrap_or_else(|| "us-east-1".into()),
                ))
                .credentials_provider(credentials)
                .interceptor(store.interceptor())
                .timeout_config(
                    aws_sdk_dynamodb::config::timeout::TimeoutConfig::builder()
                        .operation_timeout(Duration::from_secs(20))
                        .build(),
                )
                .build();
            stores.dynamo = Some(DynamoFixture {
                store,
                client: DynamoClient::from_conf(config),
                table,
            });
        }
        if let (Some(contact), Some(keyspace)) = (env("BENCH_CASSANDRA_CONTACT_POINT"), env("BENCH_CASSANDRA_KEYSPACE")) {
            let published = contact
                .to_socket_addrs()?
                .next()
                .ok_or("BENCH_CASSANDRA_CONTACT_POINT names no address")?;
            let session = SessionBuilder::new()
                .known_node(&contact)
                .address_translator(Arc::new(Published(published)))
                .use_keyspace(&keyspace, false)
                .build()
                .await?;
            stores.cassandra = Some(CassandraFixture {
                store: CassandraStore::new(session).name("tickets")?,
                select: OnceCell::new(),
            });
        }
        if let (Some(url), Some(index)) = (env("BENCH_OPENSEARCH_URL"), env("BENCH_OPENSEARCH_INDEX")) {
            let client = opensearch::OpenSearch::new(Transport::single_node(&url)?);
            stores.opensearch = Some(OpenSearchFixture {
                store: OpenSearchStore::new(client).name("articles")?,
                index,
            });
        }
        Ok(stores)
    }

    /// Registers the hooked stores, declares the store routes for Preview and marks the ones that
    /// write a guarded store `preview: false`.
    pub fn configure(&self, mut config: ConfigBuilder) -> ConfigBuilder {
        if let Some(mongo) = &self.mongo {
            config = config.data_store(mongo.clone());
            for (method, path) in [
                ("GET", "/documents/{id}"),
                ("POST", "/documents"),
                ("PATCH", "/documents/{id}"),
                ("POST", "/documents/archive"),
            ] {
                config = config.preview_operation(method, path);
            }
            config = config.preview_unavailable_for(
                "DELETE",
                "/documents/{id}",
                "Preview unavailable: this operation writes to MongoDB",
                ["mongodb"],
            );
        }
        if let Some(redis) = &self.redis {
            config = config.data_store(redis.store.clone());
            for (method, path) in [
                ("GET", "/counters/{key}"),
                ("POST", "/counters/{key}"),
                ("POST", "/counters/{key}/take"),
            ] {
                config = config.preview_operation(method, path);
            }
            config = config.preview_unavailable_for(
                "DELETE",
                "/counters/{key}",
                "Preview unavailable: this operation writes to Redis",
                ["redis"],
            );
        }
        if let Some(dynamo) = &self.dynamo {
            config = config.data_store(dynamo.store.clone());
            for (method, path) in [
                ("GET", "/orders/{id}"),
                ("POST", "/orders/{id}/touch"),
                ("POST", "/orders/{id}/cancel"),
            ] {
                config = config.preview_operation(method, path);
            }
            config = config.preview_unavailable_for(
                "DELETE",
                "/orders/{id}",
                "Preview unavailable: this operation writes to DynamoDB",
                ["dynamodb"],
            );
        }
        if let Some(cassandra) = &self.cassandra {
            config = config.data_store(cassandra.store.clone());
            for (method, path) in [
                ("GET", "/tickets/{id}"),
                ("POST", "/tickets/{id}/touch"),
                ("POST", "/tickets/{id}/close"),
            ] {
                config = config.preview_operation(method, path);
            }
            config = config.preview_unavailable_for(
                "DELETE",
                "/tickets/{id}",
                "Preview unavailable: this operation writes to Cassandra",
                ["cassandra"],
            );
        }
        if let Some(opensearch) = &self.opensearch {
            config = config.data_store(opensearch.store.clone());
            for (method, path) in [
                ("GET", "/articles/{id}"),
                ("POST", "/articles/{id}/touch"),
                ("POST", "/articles/{id}/hide"),
            ] {
                config = config.preview_operation(method, path);
            }
            config = config.preview_unavailable_for(
                "DELETE",
                "/articles/{id}",
                "Preview unavailable: this operation writes to OpenSearch",
                ["opensearch"],
            );
        }
        if self.redis.is_some()
            || self.dynamo.is_some()
            || self.cassandra.is_some()
            || self.opensearch.is_some()
        {
            config = config.preview_operation("POST", "/items/{id}/remember");
        }
        config
    }

    fn counter(&self, key: &str) -> String {
        format!("{}counter:{key}", self.prefix)
    }

    // ---- MongoDB ----

    fn shape(document: &Document) -> Value {
        let city = document
            .get_document("profile")
            .ok()
            .and_then(|profile| profile.get_str("city").ok());
        json!({ "id": document.get("_id").map(Bson::to_string).map(|id| id.trim_matches('"').to_owned()), "name": document.get_str("name").ok(), "city": city })
    }

    /// `GET /documents/{id}`.
    pub async fn document_get(&self, mongo: &Mongo, id: &str) -> Outcome {
        match mongo
            .collection::<Document>("documents")
            .find_one(doc! { "_id": id })
            .await
        {
            Ok(Some(document)) => Outcome::new(200, Self::shape(&document)),
            Ok(None) => Outcome::empty(404),
            Err(error) => failed(error),
        }
    }

    /// `POST /documents`.
    pub async fn document_create(&self, mongo: &Mongo, body: &Value) -> Outcome {
        let (Some(id), Some(name), Some(city), Some(password)) = (
            text(body.get("id")),
            text(body.get("name")),
            text(body.get("city")),
            text(body.get("password")),
        ) else {
            return Outcome::empty(400);
        };
        let document = doc! { "_id": id, "name": name, "profile": { "city": city }, "password_hash": format!("hashed:{password}") };
        if let Err(error) = mongo
            .collection::<Document>("documents")
            .insert_one(&document)
            .await
        {
            return failed(error);
        }
        capture::record_log("Information", &format!("created-document:{id}"));
        Outcome::new(201, Self::shape(&document))
    }

    /// `PATCH /documents/{id}`.
    pub async fn document_patch(&self, mongo: &Mongo, id: &str, body: &Value) -> Outcome {
        let mut set = Document::new();
        for (field, key) in [("name", "name"), ("city", "profile.city")] {
            match body.get(field) {
                None => {}
                Some(value) => match text(Some(value)) {
                    Some(value) => {
                        set.insert(key, value);
                    }
                    None => return Outcome::empty(400),
                },
            }
        }
        if set.is_empty() {
            return Outcome::empty(400);
        }
        let documents = mongo.collection::<Document>("documents");
        match documents
            .update_one(doc! { "_id": id }, doc! { "$set": set })
            .await
        {
            Ok(result) if result.matched_count == 0 => Outcome::empty(404),
            Ok(_) => match documents.find_one(doc! { "_id": id }).await {
                Ok(Some(document)) => Outcome::new(200, Self::shape(&document)),
                Ok(None) => Outcome::empty(404),
                Err(error) => failed(error),
            },
            Err(error) => failed(error),
        }
    }

    /// `POST /documents/archive`: an aggregation that writes with `$out`.
    pub async fn document_archive(&self, mongo: &Mongo) -> Outcome {
        match mongo
            .collection::<Document>("documents")
            .aggregate([doc! { "$match": {} }, doc! { "$out": "documents_archive" }])
            .await
        {
            Ok(_) => Outcome::empty(204),
            Err(error) => failed(error),
        }
    }

    /// `DELETE /documents/{id}` (`preview: false`).
    pub async fn document_delete(&self, mongo: &Mongo, id: &str) -> Outcome {
        match mongo
            .collection::<Document>("documents")
            .delete_one(doc! { "_id": id })
            .await
        {
            Ok(_) => Outcome::empty(204),
            Err(error) => failed(error),
        }
    }

    // ---- Redis ----

    fn redis_connection(
        &self,
        redis: &Redis,
    ) -> sendproof_redis::GuardedConnection<sendproof_redis::SharedConnection> {
        redis.connection()
    }

    fn counter_reply(key: &str, value: Option<i64>) -> Outcome {
        match value {
            Some(value) => Outcome::new(200, json!({ "key": key, "value": value })),
            None => Outcome::empty(404),
        }
    }

    /// `GET /counters/{key}`.
    pub async fn counter_get(&self, redis: &Redis, key: &str) -> Outcome {
        let mut connection = self.redis_connection(redis);
        match redis::cmd("GET")
            .arg(self.counter(key))
            .query_async::<Option<i64>>(&mut connection)
            .await
        {
            Ok(value) => Self::counter_reply(key, value),
            Err(error) => failed(error),
        }
    }

    /// `POST /counters/{key}`.
    pub async fn counter_incr(&self, redis: &Redis, key: &str) -> Outcome {
        let mut connection = self.redis_connection(redis);
        match redis::cmd("INCR")
            .arg(self.counter(key))
            .query_async::<i64>(&mut connection)
            .await
        {
            Ok(value) => Self::counter_reply(key, Some(value)),
            Err(error) => failed(error),
        }
    }

    /// `POST /counters/{key}/take`: `GETDEL`. Store errors are swallowed on purpose: the blocked mark,
    /// not the response, decides a Preview.
    pub async fn counter_take(&self, redis: &Redis, key: &str) -> Outcome {
        let mut connection = self.redis_connection(redis);
        let value = redis::cmd("GETDEL")
            .arg(self.counter(key))
            .query_async::<Option<i64>>(&mut connection)
            .await
            .ok()
            .flatten();
        Self::counter_reply(key, value)
    }

    /// `DELETE /counters/{key}` (`preview: false`).
    pub async fn counter_delete(&self, redis: &Redis, key: &str) -> Outcome {
        let mut connection = self.redis_connection(redis);
        match redis::cmd("DEL")
            .arg(self.counter(key))
            .query_async::<i64>(&mut connection)
            .await
        {
            Ok(_) => Outcome::empty(204),
            Err(error) => failed(error),
        }
    }

    // ---- DynamoDB ----

    fn dynamo(&self) -> &DynamoFixture {
        self.dynamo
            .as_ref()
            .expect("DynamoDB routes exist only when DynamoDB is hooked")
    }

    fn order(item: &std::collections::HashMap<String, AttributeValue>) -> Value {
        let string = |name: &str| item.get(name).and_then(|value| value.as_s().ok()).cloned();
        let hits = item
            .get("hits")
            .and_then(|value| value.as_n().ok())
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(0);
        json!({ "id": string("id"), "status": string("status"), "hits": hits })
    }

    /// `GET /orders/{id}`.
    pub async fn order_get(&self, id: &str) -> Outcome {
        let dynamo = self.dynamo();
        match dynamo
            .client
            .get_item()
            .table_name(&dynamo.table)
            .key("id", AttributeValue::S(id.into()))
            .consistent_read(true)
            .send()
            .await
        {
            Ok(output) => output.item().map_or_else(
                || Outcome::empty(404),
                |item| Outcome::new(200, Self::order(item)),
            ),
            Err(error) => failed(aws_sdk_dynamodb::error::DisplayErrorContext(error)),
        }
    }

    /// The `touch` update: `ADD hits :one SET #s = if_not_exists(#s, :new)`, returning the new item.
    pub async fn order_touch(&self, id: &str) -> Outcome {
        let dynamo = self.dynamo();
        let result = dynamo
            .client
            .update_item()
            .table_name(&dynamo.table)
            .key("id", AttributeValue::S(id.into()))
            .update_expression("ADD hits :one SET #s = if_not_exists(#s, :new)")
            .expression_attribute_names("#s", "status")
            .expression_attribute_values(":one", AttributeValue::N("1".into()))
            .expression_attribute_values(":new", AttributeValue::S("new".into()))
            .return_values(aws_sdk_dynamodb::types::ReturnValue::AllNew)
            .send()
            .await;
        match result {
            Ok(output) => output.attributes().map_or_else(
                || Outcome::empty(404),
                |item| Outcome::new(200, Self::order(item)),
            ),
            Err(error) => failed(aws_sdk_dynamodb::error::DisplayErrorContext(error)),
        }
    }

    /// `POST /orders/{id}/cancel`: a PartiQL `UPDATE`, which travels through `ExecuteStatement`.
    pub async fn order_cancel(&self, id: &str) -> Outcome {
        let dynamo = self.dynamo();
        let statement = format!(
            "UPDATE \"{}\" SET status = 'cancelled' WHERE id = ?",
            dynamo.table
        );
        match dynamo
            .client
            .execute_statement()
            .statement(statement)
            .parameters(AttributeValue::S(id.into()))
            .send()
            .await
        {
            Ok(_) => Outcome::new(200, json!({ "id": id, "status": "cancelled" })),
            Err(error) => failed(aws_sdk_dynamodb::error::DisplayErrorContext(error)),
        }
    }

    /// `DELETE /orders/{id}` (`preview: false`).
    pub async fn order_delete(&self, id: &str) -> Outcome {
        let dynamo = self.dynamo();
        match dynamo
            .client
            .delete_item()
            .table_name(&dynamo.table)
            .key("id", AttributeValue::S(id.into()))
            .send()
            .await
        {
            Ok(_) => Outcome::empty(204),
            Err(error) => failed(aws_sdk_dynamodb::error::DisplayErrorContext(error)),
        }
    }

    // ---- Cassandra ----

    fn cassandra(&self) -> &CassandraFixture {
        self.cassandra
            .as_ref()
            .expect("Cassandra routes exist only when Cassandra is hooked")
    }

    /// `GET /tickets/{id}`: the prepared `SELECT`, executed (the hook classifies the execution by the
    /// text it was prepared from).
    pub async fn ticket_get(&self, cassandra: &Cassandra, id: &str) -> Outcome {
        let session = cassandra.session();
        let select = match self
            .cassandra()
            .select
            .get_or_try_init(|| session.prepare("SELECT id, status, hits FROM tickets WHERE id = ?"))
            .await
        {
            Ok(select) => select,
            Err(error) => return failed(error),
        };
        let result = match session.execute_unpaged(select, (id,)).await {
            Ok(result) => result,
            Err(error) => return failed(error),
        };
        let rows = match result.into_rows_result() {
            Ok(rows) => rows,
            Err(error) => return failed(error),
        };
        match rows.rows::<(String, Option<String>, Option<i32>)>() {
            Ok(mut rows) => match rows.next() {
                Some(Ok((id, status, hits))) => {
                    Outcome::new(200, json!({ "id": id, "status": status, "hits": hits }))
                }
                Some(Err(error)) => failed(error),
                None => Outcome::empty(404),
            },
            Err(error) => failed(error),
        }
    }

    /// `POST /tickets/{id}/touch`: an `INSERT` with literals in the text and the id bound.
    pub async fn ticket_touch(&self, cassandra: &Cassandra, id: &str) -> Outcome {
        match cassandra
            .session()
            .query_unpaged(
                "INSERT INTO tickets (id, status, hits) VALUES (?, 'new', 1)",
                (id,),
            )
            .await
        {
            Ok(_) => Outcome::new(200, json!({ "id": id, "status": "new", "hits": 1 })),
            Err(error) => failed(error),
        }
    }

    /// `POST /tickets/{id}/close`: one logged batch holding a lightweight-transaction `UPDATE`.
    pub async fn ticket_close(&self, cassandra: &Cassandra, id: &str) -> Outcome {
        let mut batch = Batch::default();
        batch.append_statement("UPDATE tickets SET status = 'closed' WHERE id = ? IF EXISTS");
        match cassandra.session().batch(&batch, ((id,),)).await {
            Ok(_) => Outcome::new(200, json!({ "id": id, "status": "closed" })),
            Err(error) => failed(error),
        }
    }

    /// `DELETE /tickets/{id}` (`preview: false`).
    pub async fn ticket_delete(&self, cassandra: &Cassandra, id: &str) -> Outcome {
        match cassandra
            .session()
            .query_unpaged("DELETE FROM tickets WHERE id = ?", (id,))
            .await
        {
            Ok(_) => Outcome::empty(204),
            Err(error) => failed(error),
        }
    }

    // ---- OpenSearch ----

    fn opensearch(&self) -> &OpenSearchFixture {
        self.opensearch
            .as_ref()
            .expect("OpenSearch routes exist only when OpenSearch is hooked")
    }

    /// One request through the guarded client: the status and the JSON body (`Null` when it has none).
    async fn search_call(
        &self,
        search: &OpenSearch,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<(u16, Value), Outcome> {
        let response = search
            .client()
            .send(
                method,
                path,
                HeaderMap::new(),
                None::<&()>,
                body.map(JsonBody::new),
                None,
            )
            .await
            .map_err(failed)?;
        let status = response.status_code().as_u16();
        let body = response.json::<Value>().await.unwrap_or(Value::Null);
        Ok((status, body))
    }

    fn article(id: &str, source: &Value) -> Outcome {
        Outcome::new(
            200,
            json!({ "id": id, "title": source["title"], "views": source["views"] }),
        )
    }

    /// `GET /articles/{id}`: a `POST` to `_search`, which reads.
    pub async fn article_get(&self, search: &OpenSearch, id: &str) -> Outcome {
        let path = format!("/{}/_search", self.opensearch().index);
        let query = json!({ "query": { "ids": { "values": [id] } }, "size": 1 });
        match self
            .search_call(search, Method::Post, &path, Some(query))
            .await
        {
            Ok((200, body)) => match body["hits"]["hits"].get(0) {
                Some(hit) => Self::article(id, &hit["_source"]),
                None => Outcome::empty(404),
            },
            Ok((status, _)) => Outcome::problem(500, &format!("OpenSearch answered {status}")),
            Err(outcome) => outcome,
        }
    }

    /// `POST /articles/{id}/touch`: a scripted `_update` with an upsert.
    pub async fn article_touch(&self, search: &OpenSearch, id: &str) -> Outcome {
        let path = format!(
            "/{}/_update/{}?refresh=true",
            self.opensearch().index,
            segment(id)
        );
        let update = json!({
            "script": { "source": "ctx._source.views += params.step", "params": { "step": 1 } },
            "upsert": { "title": "Untitled", "views": 1 },
            "_source": true,
        });
        match self
            .search_call(search, Method::Post, &path, Some(update))
            .await
        {
            Ok((status, body)) if status < 300 => Self::article(id, &body["get"]["_source"]),
            Ok((status, _)) => Outcome::problem(500, &format!("OpenSearch answered {status}")),
            Err(outcome) => outcome,
        }
    }

    /// `POST /articles/{id}/hide`: an `_update_by_query`, a `POST` with a query like a search. Any store
    /// error becomes a 404, so a blocked write is swallowed and only the Preview's mark can fail it.
    pub async fn article_hide(&self, search: &OpenSearch, id: &str) -> Outcome {
        let path = format!(
            "/{}/_update_by_query?refresh=true",
            self.opensearch().index
        );
        let update = json!({
            "query": { "ids": { "values": [id] } },
            "script": { "source": "ctx._source.hidden = true" },
        });
        match self
            .search_call(search, Method::Post, &path, Some(update))
            .await
        {
            Ok((status, body)) if status < 300 && body["updated"].as_u64().unwrap_or(0) > 0 => {
                Outcome::new(200, json!({ "id": id, "hidden": true }))
            }
            _ => Outcome::empty(404),
        }
    }

    /// `DELETE /articles/{id}` (`preview: false`).
    pub async fn article_delete(&self, search: &OpenSearch, id: &str) -> Outcome {
        let path = format!(
            "/{}/_doc/{}?refresh=true",
            self.opensearch().index,
            segment(id)
        );
        match self.search_call(search, Method::Delete, &path, None).await {
            Ok((status, _)) if status < 300 || status == 404 => Outcome::empty(204),
            Ok((status, _)) => Outcome::problem(500, &format!("OpenSearch answered {status}")),
            Err(outcome) => outcome,
        }
    }

    /// The write half of `POST /items/{id}/remember`: `INCR` for Redis, the `touch` update on item
    /// `item-<id>` for DynamoDB, the `touch` insert of ticket `item-<id>` for Cassandra and the `touch`
    /// update of article `item-<id>` for OpenSearch. `None` when `store` names none of them.
    pub async fn remember(
        &self,
        handles: Handles<'_>,
        store: &str,
        id: &str,
    ) -> Option<Result<(), Outcome>> {
        let redis = handles.redis;
        let done = |outcome: Outcome| {
            Some(if outcome.status == 200 {
                Ok(())
            } else {
                Err(outcome)
            })
        };
        match store {
            "cassandra" if self.cassandra.is_some() => {
                done(self.ticket_touch(handles.cassandra?, &format!("item-{id}")).await)
            }
            "opensearch" if self.opensearch.is_some() => {
                done(self.article_touch(handles.opensearch?, &format!("item-{id}")).await)
            }
            "redis" => {
                let outcome = self.counter_incr(redis?, &format!("item-{id}")).await;
                Some(if outcome.status == 200 {
                    Ok(())
                } else {
                    Err(outcome)
                })
            }
            "dynamodb" if self.dynamo.is_some() => {
                let outcome = self.order_touch(&format!("item-{id}")).await;
                Some(if outcome.status == 200 {
                    Ok(())
                } else {
                    Err(outcome)
                })
            }
            _ => None,
        }
    }
}
