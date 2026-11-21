//! The data-store routes of the fixture (`spec/conformance/fixture.md`, "Data store routes").
//!
//! Each store is hooked only when the runner passes its variables, so the standard and alternate
//! scenarios run without any store service. The routes use the clients exactly as an application
//! would: MongoDB through the guarded `Mongo` handle, Redis through a guarded connection and
//! DynamoDB through a client built with the interceptor. Framework-neutral: the Axum and Actix
//! fixtures call these with the handles their extractors produce.

use std::time::Duration;

use aws_sdk_dynamodb::{Client as DynamoClient, config::Region, types::AttributeValue};
use aws_credential_types::Credentials;
use mongodb::{
    bson::{Bson, Document, doc},
    options::ClientOptions,
};
use sendproof_core::{ConfigBuilder, capture};
use sendproof_dynamodb::DynamoStore;
use sendproof_mongodb::{Mongo, MongoStore};
use sendproof_redis::{Redis, RedisStore};
use serde_json::{Value, json};

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

/// The stores the runner provisioned for this fixture process.
#[derive(Default)]
pub struct Stores {
    pub mongo: Option<MongoStore>,
    pub redis: Option<RedisFixture>,
    pub dynamo: Option<DynamoFixture>,
    /// The fresh key prefix every Redis key starts with.
    pub prefix: String,
}

fn text(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|text| !text.is_empty() && text.len() <= 150)
}

fn failed(error: impl std::fmt::Display) -> Outcome {
    // The detail is the store's own error: a refusal names the command, never a value.
    Outcome::problem(500, &error.to_string())
}

impl Stores {
    /// Connects to the stores whose variables are set.
    pub async fn from_env() -> Result<Self, Box<dyn std::error::Error>> {
        let env = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
        let mut stores = Self { prefix: env("BENCH_REDIS_PREFIX").unwrap_or_default(), ..Self::default() };
        if let Some(url) = env("BENCH_MONGODB_URL") {
            let options = ClientOptions::parse(&url).await?;
            let database = options.default_database.clone().unwrap_or_else(|| "test".into());
            stores.mongo = Some(MongoStore::builder(options, database).name("catalog")?.build()?);
        }
        if let Some(url) = env("BENCH_REDIS_URL") {
            let connection = redis::Client::open(url)?.get_multiplexed_async_connection().await?;
            stores.redis = Some(RedisFixture { store: RedisStore::new().connection(connection).name("cache")? });
        }
        if let (Some(endpoint), Some(table)) = (env("BENCH_DYNAMODB_URL"), env("BENCH_DYNAMODB_TABLE")) {
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
                .region(Region::new(env("AWS_REGION").unwrap_or_else(|| "us-east-1".into())))
                .credentials_provider(credentials)
                .interceptor(store.interceptor())
                .timeout_config(aws_sdk_dynamodb::config::timeout::TimeoutConfig::builder().operation_timeout(Duration::from_secs(20)).build())
                .build();
            stores.dynamo = Some(DynamoFixture { store, client: DynamoClient::from_conf(config), table });
        }
        Ok(stores)
    }

    /// Registers the hooked stores, declares the store routes for Preview and marks the ones that
    /// write a guarded store `preview: false`.
    pub fn configure(&self, mut config: ConfigBuilder) -> ConfigBuilder {
        if let Some(mongo) = &self.mongo {
            config = config.data_store(mongo.clone());
            for (method, path) in [("GET", "/documents/{id}"), ("POST", "/documents"), ("PATCH", "/documents/{id}"), ("POST", "/documents/archive")] {
                config = config.preview_operation(method, path);
            }
            config = config.preview_unavailable_for("DELETE", "/documents/{id}", "Preview unavailable: this operation writes to MongoDB", ["mongodb"]);
        }
        if let Some(redis) = &self.redis {
            config = config.data_store(redis.store.clone());
            for (method, path) in [("GET", "/counters/{key}"), ("POST", "/counters/{key}"), ("POST", "/counters/{key}/take")] {
                config = config.preview_operation(method, path);
            }
            config = config.preview_unavailable_for("DELETE", "/counters/{key}", "Preview unavailable: this operation writes to Redis", ["redis"]);
        }
        if let Some(dynamo) = &self.dynamo {
            config = config.data_store(dynamo.store.clone());
            for (method, path) in [("GET", "/orders/{id}"), ("POST", "/orders/{id}/touch"), ("POST", "/orders/{id}/cancel")] {
                config = config.preview_operation(method, path);
            }
            config = config.preview_unavailable_for("DELETE", "/orders/{id}", "Preview unavailable: this operation writes to DynamoDB", ["dynamodb"]);
        }
        if self.redis.is_some() || self.dynamo.is_some() {
            config = config.preview_operation("POST", "/items/{id}/remember");
        }
        config
    }

    fn counter(&self, key: &str) -> String {
        format!("{}counter:{key}", self.prefix)
    }

    // ---- MongoDB ----

    fn shape(document: &Document) -> Value {
        let city = document.get_document("profile").ok().and_then(|profile| profile.get_str("city").ok());
        json!({ "id": document.get("_id").map(Bson::to_string).map(|id| id.trim_matches('"').to_owned()), "name": document.get_str("name").ok(), "city": city })
    }

    /// `GET /documents/{id}`.
    pub async fn document_get(&self, mongo: &Mongo, id: &str) -> Outcome {
        match mongo.collection::<Document>("documents").find_one(doc! { "_id": id }).await {
            Ok(Some(document)) => Outcome::new(200, Self::shape(&document)),
            Ok(None) => Outcome::empty(404),
            Err(error) => failed(error),
        }
    }

    /// `POST /documents`.
    pub async fn document_create(&self, mongo: &Mongo, body: &Value) -> Outcome {
        let (Some(id), Some(name), Some(city), Some(password)) =
            (text(body.get("id")), text(body.get("name")), text(body.get("city")), text(body.get("password")))
        else {
            return Outcome::empty(400);
        };
        let document = doc! { "_id": id, "name": name, "profile": { "city": city }, "password_hash": format!("hashed:{password}") };
        if let Err(error) = mongo.collection::<Document>("documents").insert_one(&document).await {
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
        match documents.update_one(doc! { "_id": id }, doc! { "$set": set }).await {
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
        match mongo.collection::<Document>("documents").aggregate([doc! { "$match": {} }, doc! { "$out": "documents_archive" }]).await {
            Ok(_) => Outcome::empty(204),
            Err(error) => failed(error),
        }
    }

    /// `DELETE /documents/{id}` (`preview: false`).
    pub async fn document_delete(&self, mongo: &Mongo, id: &str) -> Outcome {
        match mongo.collection::<Document>("documents").delete_one(doc! { "_id": id }).await {
            Ok(_) => Outcome::empty(204),
            Err(error) => failed(error),
        }
    }

    // ---- Redis ----

    fn redis_connection(&self, redis: &Redis) -> sendproof_redis::GuardedConnection<sendproof_redis::SharedConnection> {
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
        match redis::cmd("GET").arg(self.counter(key)).query_async::<Option<i64>>(&mut connection).await {
            Ok(value) => Self::counter_reply(key, value),
            Err(error) => failed(error),
        }
    }

    /// `POST /counters/{key}`.
    pub async fn counter_incr(&self, redis: &Redis, key: &str) -> Outcome {
        let mut connection = self.redis_connection(redis);
        match redis::cmd("INCR").arg(self.counter(key)).query_async::<i64>(&mut connection).await {
            Ok(value) => Self::counter_reply(key, Some(value)),
            Err(error) => failed(error),
        }
    }

    /// `POST /counters/{key}/take`: `GETDEL`. Store errors are swallowed on purpose: the blocked mark,
    /// not the response, decides a Preview.
    pub async fn counter_take(&self, redis: &Redis, key: &str) -> Outcome {
        let mut connection = self.redis_connection(redis);
        let value = redis::cmd("GETDEL").arg(self.counter(key)).query_async::<Option<i64>>(&mut connection).await.ok().flatten();
        Self::counter_reply(key, value)
    }

    /// `DELETE /counters/{key}` (`preview: false`).
    pub async fn counter_delete(&self, redis: &Redis, key: &str) -> Outcome {
        let mut connection = self.redis_connection(redis);
        match redis::cmd("DEL").arg(self.counter(key)).query_async::<i64>(&mut connection).await {
            Ok(_) => Outcome::empty(204),
            Err(error) => failed(error),
        }
    }

    // ---- DynamoDB ----

    fn dynamo(&self) -> &DynamoFixture {
        self.dynamo.as_ref().expect("DynamoDB routes exist only when DynamoDB is hooked")
    }

    fn order(item: &std::collections::HashMap<String, AttributeValue>) -> Value {
        let string = |name: &str| item.get(name).and_then(|value| value.as_s().ok()).cloned();
        let hits = item.get("hits").and_then(|value| value.as_n().ok()).and_then(|value| value.parse::<i64>().ok()).unwrap_or(0);
        json!({ "id": string("id"), "status": string("status"), "hits": hits })
    }

    /// `GET /orders/{id}`.
    pub async fn order_get(&self, id: &str) -> Outcome {
        let dynamo = self.dynamo();
        match dynamo.client.get_item().table_name(&dynamo.table).key("id", AttributeValue::S(id.into())).consistent_read(true).send().await {
            Ok(output) => output.item().map_or_else(|| Outcome::empty(404), |item| Outcome::new(200, Self::order(item))),
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
            Ok(output) => output.attributes().map_or_else(|| Outcome::empty(404), |item| Outcome::new(200, Self::order(item))),
            Err(error) => failed(aws_sdk_dynamodb::error::DisplayErrorContext(error)),
        }
    }

    /// `POST /orders/{id}/cancel`: a PartiQL `UPDATE`, which travels through `ExecuteStatement`.
    pub async fn order_cancel(&self, id: &str) -> Outcome {
        let dynamo = self.dynamo();
        let statement = format!("UPDATE \"{}\" SET status = 'cancelled' WHERE id = ?", dynamo.table);
        match dynamo.client.execute_statement().statement(statement).parameters(AttributeValue::S(id.into())).send().await {
            Ok(_) => Outcome::new(200, json!({ "id": id, "status": "cancelled" })),
            Err(error) => failed(aws_sdk_dynamodb::error::DisplayErrorContext(error)),
        }
    }

    /// `DELETE /orders/{id}` (`preview: false`).
    pub async fn order_delete(&self, id: &str) -> Outcome {
        let dynamo = self.dynamo();
        match dynamo.client.delete_item().table_name(&dynamo.table).key("id", AttributeValue::S(id.into())).send().await {
            Ok(_) => Outcome::empty(204),
            Err(error) => failed(aws_sdk_dynamodb::error::DisplayErrorContext(error)),
        }
    }

    /// The write half of `POST /items/{id}/remember`: `INCR` for Redis, or the `touch` update on item
    /// `item-<id>` for DynamoDB. `None` when `store` names neither.
    pub async fn remember(&self, redis: Option<&Redis>, store: &str, id: &str) -> Option<Result<(), Outcome>> {
        match store {
            "redis" => {
                let outcome = self.counter_incr(redis?, &format!("item-{id}")).await;
                Some(if outcome.status == 200 { Ok(()) } else { Err(outcome) })
            }
            "dynamodb" if self.dynamo.is_some() => {
                let outcome = self.order_touch(&format!("item-{id}")).await;
                Some(if outcome.status == 200 { Ok(()) } else { Err(outcome) })
            }
            _ => None,
        }
    }
}
