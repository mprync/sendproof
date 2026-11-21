# Conformance fixture (Rails)

A disposable Rails API backed by SQLite (or MySQL), used by the shared conformance runner and as the reference setup for `sendproof-rails`. See `spec/conformance/fixture.md` for the contract.

```sh
adapters/ruby/bin/prepare                 # once
PORT=5352 BENCH_PATH_BASE=/tenant BENCH_SCENARIO=standard adapters/ruby/bin/fixture
node tests/conformance/run.mjs ruby-rails # from the repository root
```

`BENCH_PATH_BASE` mounts the whole application under a Rack path base (`config.ru`), so `/sendproof` is not served outside it. Scenarios: `standard`, `disabled`, `no-provider`, `rollback-failure`. Trace retention is five seconds.

`BENCH_DATABASE=mysql` with `BENCH_DATABASE_URL=mysql://...` runs the same fixture on MySQL through Trilogy; the conformance runner provides both for `ruby-rails-mysql`. MySQL has no prepared statements through Trilogy, so the secret-parameter probe in `controllers.rb` reports its bind the way a prepared-statement adapter would.

The data-store routes (`spec/conformance/fixture.md`) exist only when the runner passes the store's variables, so the other scenarios need no store: `BENCH_MONGODB_URL` (Mongoid), `BENCH_REDIS_URL` with `BENCH_REDIS_PREFIX` (the `redis` gem), and `BENCH_DYNAMODB_URL` with `BENCH_DYNAMODB_TABLE` (`aws-sdk-dynamodb`). The shared-rule routes `/accounts` and `/items/{id}/commit` always exist.

- `app.rb`: application and Sendproof configuration. `controllers.rb`: models, controllers, OpenAPI document. `routes.rb`: routes.
- `test/`: in-process smoke tests (`rake test:fixture`).
