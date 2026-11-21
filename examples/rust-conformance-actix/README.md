# Rust conformance fixture (Actix Web)

The disposable Actix Web + SQLx app of `spec/conformance/fixture.md`. Behavior is shared with the Axum fixture through `rust-conformance-common`.

```sh
adapters/rust/scripts/pack-assets.sh
PORT=5375 BENCH_PATH_BASE=/tenant BENCH_SCENARIO=standard \
  cargo run --manifest-path adapters/rust/Cargo.toml -p rust-conformance-actix
# or, from the repository root:
node tests/conformance/run.mjs rust-actix
```

The database is chosen by `BENCH_DATABASE`:

* `sqlite` (the default) uses a SQLite file of its own in the temp directory and removes it on shutdown;
* `postgresql` and `mysql` connect to `BENCH_DATABASE_URL`, a fresh, disposable database, and create the `items` table themselves.

The runner profiles are `rust-actix`, `rust-actix-postgresql` and `rust-actix-mysql`:

```sh
BENCH_DATABASE=postgresql BENCH_DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/fresh_db \
  PORT=5375 cargo run --manifest-path adapters/rust/Cargo.toml -p rust-conformance-actix
```
