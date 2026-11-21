# Data stores in the Ruby binding

Sendproof Preview promises that a confirmed Preview never leaves a write behind. For SQL, the ActiveRecord provider guarantees it. For MongoDB, Redis and DynamoDB, the Ruby binding hooks each store's client, following the rules in [spec/data-stores.md](../../spec/data-stores.md):

| Store | Hook | Mode | What a Preview does |
| --- | --- | --- | --- |
| MongoDB replica set or sharded cluster | `Sendproof::Mongoid::Store` (Mongoid 9) or `Sendproof::Mongo::Store` (`mongo` driver) | `preview` | Runs every command in one transaction, reports document changes, and aborts it. |
| MongoDB standalone server | the same | `guard` | Runs reads. The first write stops the Preview. |
| Redis | `Sendproof::Redis::Store` (`redis-client`, `redis` 5, Rails' `RedisCacheStore`) | `guard` | Runs reads. The first write stops the Preview. |
| DynamoDB | `Sendproof::DynamoDB::Store` (`aws-sdk-dynamodb`, Dynamoid) | `guard` | Runs reads. The first write stops the Preview. |

Send and observed Send are never blocked. Their writes commit as usual, and an observed Send traces every store command as a `Db` log entry.

The hooks live in the `sendproof-core` gem and load on demand, so the core gem needs none of the client gems: `require "sendproof/mongoid"`, `"sendproof/mongo"`, `"sendproof/redis"` or `"sendproof/dynamodb"` for the stores you use.

## Coverage: only hooked clients are covered

> [!WARNING]
> The binding covers a store only through the client you hook. Other clients are not covered: their writes are neither blocked nor rolled back. That includes a client created inside a handler, a second client for the same store, a Redis `pubsub` connection, a raw socket, and a client from a library the hook doesn't know. Hook every client your handlers use, at startup.

Details per store are below. In short:

- **Redis.** `RedisClient.register` is process-wide, so by default every `redis-client` (and `redis` 5) client in the process is guarded. Pass `global: false` to cover one client instead.
- **DynamoDB.** Hook one client with `client:`, every client created afterwards with `global: true`, or build a client with the store's `plugin`.
- **MongoDB.** The store hooks one `Mongo::Client` (Mongoid's `:default` client, or the one you pass). A different client is not covered.

## Register the stores

```ruby
# config/initializers/sendproof.rb
Rails.application.configure do
  config.sendproof.environments = %w[development]
  config.sendproof.open_api_url = "/openapi.json"
  config.sendproof.use Sendproof::ActiveRecord::Provider.new          # the SQL rollback provider (optional)
  config.sendproof.data_store Sendproof::Mongoid::Store.new(name: "catalog")
  config.sendproof.data_store Sendproof::Redis::Store.new(name: "cache")
  config.sendproof.data_store Sendproof::DynamoDB::Store.new(client: Aws::DynamoDB::Client.new, name: "orders")
end
```

`name` is the label the workbench shows. It must be a display name such as `catalog`, never a URL, host name or credentials; a value that looks like one raises `ArgumentError`.

A SQL provider is optional when you register stores. An app whose only database is MongoDB, or that has only Redis or DynamoDB, can Preview without one: MongoDB rolls back its own transaction and the guarded stores block writes. A SQL database you give no provider for is then not covered, like any unhooked client.

### MongoDB with Mongoid

`Sendproof::Mongoid::Store.new(client: :default)` hooks the named Mongoid client. During a Preview the transaction session is ambient for Mongoid, so models, queries, `save`, `create`, `update`, `destroy` and aggregations run in it with no change to your code. Models that use another client, or `Model.with(client: ...)` to reach one, are not covered.

- `Model.transaction` and `Model.with_session` inside a Preview join the Preview transaction. A `Mongoid::Errors::Rollback` ends the block, but the writes made so far stay in the Preview transaction, which is rolled back at the end anyway and still shows in the changes.
- `Model.collection.insert_one(...)` and the other raw driver calls bypass the model layer and carry no session. The hook refuses a write like that before it is sent, and the Preview answers 500 rather than claim a rollback. Use model methods in previewed handlers.
- `Model.estimated_count` sends `count`, which MongoDB refuses inside a transaction, so a Preview of a handler that calls it is blocked with that reason. Use `Model.count` (`countDocuments`).

### MongoDB with the plain driver

`Sendproof::Mongo::Store.new(client)` returns a store whose `client` is a guarded `Mongo::Client` with the driver's own API. Handlers must use it, not the original client:

```ruby
catalog = Sendproof::Mongo::Store.new(Mongo::Client.new(url), name: "catalog")
config.sendproof.data_store catalog
catalog.client[:documents].insert_one(_id: "a", name: "A")   # in a Preview: runs in the Preview transaction
```

- During a Preview, every database and collection method that sends a command adds the Preview session to its options. A call that passes its own session is refused, and the Preview answers 500.
- `client.start_session` and `client.with_session` hand out the Preview session. Its `start_transaction` and `with_transaction` run inside the Preview transaction; its `commit_transaction` and `abort_transaction` never reach the server and fail the Preview with 500, like a raw SQL `COMMIT`. A raw `{ commitTransaction: 1 }` or `{ abortTransaction: 1 }` through `database.command` is refused the same way.
- A Preview may hold its transaction for `preview_timeout:` seconds, 50 by default (below MongoDB's 60-second transaction lifetime). A handler still running at the limit loses the transaction: its later commands fail, nothing commits, and the Preview answers 500.

### How the MongoDB guard works

The Ruby driver has no documented hook that can stop a command, so the store relies on its command-monitoring subscriber: the driver calls `started` on the calling thread before it writes the command to the socket, and an exception raised there propagates out of the driver call. The store raises from it to refuse a command, so no byte of the command is sent. This is the driver's behavior, not a promise in its documentation, so the test suite proves it with an independent read after each refusal, and if a future driver swallowed the exception the Preview is still never confirmed: the store records the refusal first and flags any refused command that reaches the server.

The same subscriber classifies every command during a Preview:

- on a standalone server (`guard` mode), a write is refused and the Preview answers 409;
- on a replica set (`preview` mode), what MongoDB can't run in a transaction (`$out`, `$merge`, `count`, an explicit `create`, `drop`, `listCollections`, `listIndexes` …) is refused with a reason such as "Preview unavailable: MongoDB can't run $out inside a transaction", and a write that doesn't carry the Preview's session and `autocommit: false` is refused and fails the Preview with 500.

A refused command marks its pooled connection as failed, so the next operation on it opens a new one. That costs one reconnect per refusal and is invisible otherwise.

Each Preview keeps the mode it started in. If the topology check failed when a Preview began, that Preview runs in `guard` mode even if a later check succeeds.

A direct connection (`directConnection=true` with one host, no replica set name) is a "single" topology to the Ruby driver, which then refuses transactions and non-primary read preferences itself. The server is verified as a replica set member with `hello` first, and the two client-side checks are lifted for the Preview session only. A client built with the replica set name and all the hosts needs neither.

### Redis

`Sendproof::Redis::Store.new` registers a `redis-client` middleware that sees every command, pipeline and `MULTI` before any byte is written, so a refused write sends no command of the batch, not even `MULTI`. `redis` 5 and Rails' `RedisCacheStore` use `redis-client` underneath and are covered.

- `global: false` leaves the middleware unregistered: add `store.middleware` to one client with `RedisClient.config(middlewares: [store.middleware])`.
- A second global store is refused until the first is `unhook!`ed, so no command is logged twice.
- A write refused after a bare `MULTI` sends `DISCARD`, so the connection is never left with a queue a later `EXEC` could run.
- `pubsub` connections bypass the middleware and are not covered.
- Sidekiq enqueues are writes, so a Preview that enqueues a job is blocked. Record the job as an effect instead: `Sendproof.record_job("Welcome email", name: "WelcomeJob")`.
- Rails' `RedisCacheStore` reads and writes through the same middleware. A `Rails.cache.fetch` that misses writes, so a Preview of that handler is blocked: the guard is right, because the write is real.

### DynamoDB

`Sendproof::DynamoDB::Store.new(client:)` adds a handler at the Seahorse `initialize` step, which runs before a request is validated, serialized or signed, so credentials and signatures never reach a capture. `Aws::DynamoDB::Resource` and Dynamoid use the same client, so hooking the client covers them. A PartiQL statement (`execute_statement` and its batch and transaction forms) is a read only when every statement in it is a `SELECT`.

## Mark an operation `preview: false`

An action you know writes to a guarded store, such as one that clears a Redis session, can be marked `preview: false`. The workbench then shows "Preview unavailable" with your reason before anyone tries, and a Preview of it is refused (409, never confirmed) without running the action. Send still runs it. The binding never infers the mark; without it the action is advertised and the guard decides at run time.

Give a `reason`, the `stores` it writes, or both. With only `stores`, the reason is "Preview unavailable: this operation writes to Redis" (for the first store).

```ruby
class SessionsController < ApplicationController
  sendproof_preview only: %i[create update]
  sendproof_no_preview only: :destroy, reason: "Clears the Redis session"
  # or: sendproof_no_preview only: :destroy, stores: :redis
end
```

Without Rails, set `config.preview_unavailable = [{ method: "DELETE", path: "/sessions/{id}", reason: "Clears the Redis session", stores: ["redis"] }]` on `Sendproof::Configuration`, and leave the operation out of `preview_operations`.

## What a blocked Preview returns

When the guard refuses a write, the command never reaches the store and the handler gets a `Sendproof::PreviewWriteBlocked` (with `store` and `operation`). The Preview then answers 409 with `application/problem+json`, whatever the handler made of the error:

```json
{ "type": "about:blank", "title": "Preview unavailable", "status": 409, "code": "preview_unavailable",
  "detail": "Preview unavailable: this operation writes to Redis", "store": "redis", "operation": "INCR", "rolledBack": false }
```

The SQL transaction rolls back as usual. A failed rollback or abort, a handler `COMMIT` or `commitTransaction`, a Preview past its time limit, or a write that escaped the MongoDB session answers 500 without confirmation instead. `Sendproof::PreviewTransactionControl` is the error the handler sees for those.

A raw SQL `COMMIT`, `END`, `ROLLBACK` (without `TO`), `BEGIN` or `SET autocommit` that a handler runs through the ActiveRecord connection (`execute`, `exec_query`, any model query) is refused the same way before it reaches the database, and on MySQL and MariaDB so are the statements that commit implicitly (`CREATE`, `ALTER`, `DROP` …). `SAVEPOINT` stays allowed. A statement sent on the driver's own handle (`connection.raw_connection`) is not covered.

## Host-declared reads

Each store takes `treat_as_read:`, a list of exact command names the guard should let through, such as a custom Redis module read:

```ruby
Sendproof::Redis::Store.new(treat_as_read: ["MYMODULE.GET"])
```

> [!WARNING]
> `treat_as_read` is your statement that the command never writes. The guard trusts it: a listed command that does write is not blocked, and its write happens during the Preview. Names match exactly, with no wildcards.

## MongoDB limits

These come from MongoDB's transaction limits; see [MongoDB in Preview](../../spec/data-stores.md#mongodb-in-preview).

- A Preview whose handler runs longer than `preview_timeout` (50 seconds by default) fails with 500, and nothing is written.
- Two Previews that write the same document don't queue: the second gets a `WriteConflict` (`Mongo::Error::OperationFailure` with code 112), and the handler decides what to answer. The Preview still rolls back.
- Keep a Preview under about 1,000 changed documents.
- Document `before` images are read at the Preview transaction's snapshot time, so a concurrent commit by another request never shows up as a change.
- An explicit `create` (`create_collection`) fails inside a Preview, because MongoDB refuses it in a transaction with snapshot read concern. Inserting into a new collection creates it and rolls back.

## MySQL Previews take turns

On MySQL and MariaDB, the ActiveRecord provider lets one Preview run at a time in each process, and further Previews wait their turn. InnoDB checks a new key for duplicates under a shared lock. When three or more transactions insert the same key and the first one rolls back, as every Preview does, InnoDB aborts all but one of the rest with a deadlock (error 1213), at any isolation level. Previews sent to different processes still run at the same time and can still hit it; the Preview then fails safely and nothing is written. Sends and observed sends never wait. See [verified databases](../../docs/bindings/databases.md).

MySQL through Trilogy and `mysql2` does not use prepared statements, so Active Record inlines parameter values into the SQL text. The Sql log hides those values too: a statement that names a secret, or any statement when parameter values are hidden, is logged with every literal replaced by `?`.

## Logs and redaction

Every store command in a Preview or observed-Send trace is a `Db` log entry with the store, operation, target, sanitized statement, rows and time. Statements never carry values: MongoDB statements keep field names and operators with every literal as `"?"`, Redis statements keep the command and key names (`SET session:42 ?`), and DynamoDB statements are the PartiQL text with every inline string or number literal replaced by `?`. Session commands such as `AUTH` and `hello` are never logged, and the DynamoDB hook never sees credentials or signatures.

Change records for MongoDB carry `store`, `namespace`, the collection as `table`, `{ _id }` as `key`, and whole nested documents as `before` and `after`. A field with a secret name, such as `password_hash` or `apiKey`, is `"[REDACTED]"` at any depth. `via` is `"upsert"` or `"replace"` when the change came from an upsert or a whole-document replacement.

Rails logs request parameters, and a capture copies the request log. Keep `config.filter_parameters` as Rails generates it so a password in a request body never reaches a capture.

## Tests

`bin/test` runs the suites. The store tests need the compose services and skip, with the command in the reason, when one doesn't answer:

```sh
docker compose -f tests/conformance/compose.yml up -d --wait mongodb redis dynamodb mysql
bin/test                      # from adapters/ruby
bin/test-mysql                # the ActiveRecord suite on MySQL (the conformance runner provides BENCH_DATABASE_URL)
node tests/conformance/run.mjs ruby-rails
BENCH_MYSQL_URL='mysql://root:bench_local@127.0.0.1:53306/mysql' node tests/conformance/run.mjs ruby-rails-mysql
```

After changing `spec/data-stores/`, run `bundle exec rake stores:embed` to regenerate the embedded tables; a test fails when they differ.
