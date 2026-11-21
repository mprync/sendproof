# Rust conformance fixture

The disposable Axum + SQLx app of `spec/conformance/fixture.md`, used by the shared runner.

```sh
adapters/rust/scripts/pack-assets.sh
PORT=5367 BENCH_PATH_BASE=/tenant BENCH_SCENARIO=standard \
  cargo run --manifest-path adapters/rust/Cargo.toml -p rust-conformance
# or, from the repository root:
node tests/conformance/run.mjs rust-axum
```

`BENCH_SCENARIO` is `standard`, `disabled`, `no-provider` or `rollback-failure`. Passwords and session handling here are fixture-only.

The database is chosen by `BENCH_DATABASE`:

* `sqlite` (the default) uses a SQLite file of its own in the temp directory and removes it on shutdown;
* `postgresql` and `mysql` connect to `BENCH_DATABASE_URL`, a fresh, disposable database, and create the `items` table themselves.

The runner profiles are `rust-axum`, `rust-axum-postgresql` and `rust-axum-mysql`:

```sh
BENCH_DATABASE=postgresql BENCH_DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/fresh_db \
  PORT=5367 cargo run --manifest-path adapters/rust/Cargo.toml -p rust-conformance
```
