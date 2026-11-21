# sendproof-dynamodb

DynamoDB write guard for Sendproof (`guard` mode): an AWS SDK interceptor that stops a Preview **before the first write is signed or sent**.

```rust
let store = DynamoStore::new().name("orders")?;           // register with Config::builder(..).data_store(store)
let config = aws_sdk_dynamodb::config::Builder::from(&sdk_config).interceptor(store.interceptor()).build();
let client = aws_sdk_dynamodb::Client::from_conf(config);
```

* Reads (`GetItem`, `Query`, `Scan`, `BatchGetItem`, `TransactGetItems`, `Describe*`, `List*`) run and become `Db` log entries.
* `PutItem`, `UpdateItem`, `DeleteItem`, `BatchWriteItem`, `TransactWriteItems`, any action the shared table doesn't list, and a PartiQL request with any statement that isn't a `SELECT` are writes: refused with an SDK error, the Preview is marked blocked and answers 409 even if the handler swallows the error.
* PartiQL text in `Db` entries has its literals replaced with `?`. Credentials, the `Authorization` header and signatures never reach the guard: it runs before signing.
* `treat_as_read(["MyAction"])` declares host reads by exact action name. It is your statement that the action never writes.

**Coverage:** only clients built with the interceptor are covered. A write the interceptor can't attribute to a request (sent from a spawned task) fails every open Preview with 500; wrap background work that writes in `sendproof_core::detached`. See [the data-stores page](../data-stores.md).
