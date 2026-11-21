# Conformance fixture (Rails)

A disposable Rails API backed by one SQLite table, used by the shared conformance runner and as the reference setup for `sendproof-rails`. See `spec/conformance/fixture.md` for the contract.

```sh
adapters/ruby/bin/prepare                 # once
PORT=5352 BENCH_PATH_BASE=/tenant BENCH_SCENARIO=standard adapters/ruby/bin/fixture
node tests/conformance/run.mjs ruby-rails # from the repository root
```

`BENCH_PATH_BASE` mounts the whole application under a Rack path base (`config.ru`), so `/sendproof` is not served outside it. Scenarios: `standard`, `disabled`, `no-provider`, `rollback-failure`. Trace retention is five seconds.

- `app.rb`: application and Sendproof configuration. `controllers.rb`: models, controllers, OpenAPI document. `routes.rb`: routes.
- `test/`: in-process smoke tests (`rake test:fixture`).
