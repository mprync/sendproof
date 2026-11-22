# Conformance fixture (Rails)

A disposable Rails API backed by SQLite (or MySQL or PostgreSQL), used by the shared conformance runner and as the reference setup for `sendproof-rails`. See `spec/conformance/fixture.md` for the contract.

```sh
adapters/ruby/bin/prepare                 # once
PORT=5352 BENCH_PATH_BASE=/tenant BENCH_SCENARIO=standard adapters/ruby/bin/fixture
node tests/conformance/run.mjs ruby-rails # from the repository root
```

`BENCH_PATH_BASE` mounts the whole application under a Rack path base (`config.ru`), so `/sendproof` is not served outside it. Scenarios: `standard`, `disabled`, `no-provider`, `rollback-failure`. Trace retention is five seconds.

`BENCH_DATABASE=postgresql` with `BENCH_DATABASE_URL=postgresql://...` runs it on PostgreSQL through the `pg` gem (`ruby-rails-postgresql`). `BENCH_DATABASE=mysql` with `BENCH_DATABASE_URL=mysql://...` runs the same fixture on MySQL through Trilogy; the conformance runner provides both for `ruby-rails-mysql`. MySQL has no prepared statements through Trilogy, so the secret-parameter probe in `controllers.rb` reports its bind the way a prepared-statement adapter would.

The data-store routes (`spec/conformance/fixture.md`) exist only when the runner passes the store's variables, so the other scenarios need no store: `BENCH_MONGODB_URL` (Mongoid), `BENCH_REDIS_URL` with `BENCH_REDIS_PREFIX` (the `redis` gem), `BENCH_DYNAMODB_URL` with `BENCH_DYNAMODB_TABLE` (`aws-sdk-dynamodb`), and `BENCH_OPENSEARCH_URL` with `BENCH_OPENSEARCH_INDEX` (`opensearch-ruby`, guarded by the global store, which hooks the client the fixture builds first). Ruby has no Cassandra client, so the Cassandra routes never exist. The shared-rule routes `/accounts` and `/items/{id}/commit` always exist.

- `app.rb`: application and Sendproof configuration. `controllers.rb`: models, controllers, OpenAPI document. `routes.rb`: routes.
- `test/`: in-process smoke tests (`rake test:fixture`).
