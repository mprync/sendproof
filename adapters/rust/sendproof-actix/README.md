# sendproof-actix

Actix Web integration for Sendproof. See the [Rust overview](../README.md) for the safety model.

```rust
let bench = Sendproof::new(config);
App::new()
    .wrap(bench.middleware())                // outermost: mounts /sendproof, dispatches previews
    .app_data(web::Data::new(pool.clone()))  // for the `Db` extractor
    .service(
        web::resource("/items")
            .wrap(bench.gate())              // innermost ...
            .wrap(from_fn(authorize))        // ... wrapped by authorization (the last `wrap` runs first)
            .route(web::post().to(create_item)),
    )
```

* `bench.middleware()` handles `{path_base}/sendproof/**` and `{path_base}/sendproof/_preview/**` and forwards everything else. Mount your own scope at the same `path_base`.
* A preview is rewritten and dispatched **in-process** through your real application, so routing, middleware and extractors are the real ones. The response is buffered (max 1 MiB) and wrapped in the confirmed envelope only after a successful rollback.
* `bench.gate()` enrolls a declared operation. **Actix runs the last `wrap` first**, so wrap the gate first and authentication/authorization after it. Declared operations use Actix resource patterns relative to the mount (`/items/{id}`), compared with `match_pattern()`.
* Do not give the app a catch-all empty-prefix scope that would answer `/sendproof/**` when Sendproof is disabled.
* `Db` (from `sendproof-sqlx` with the `actix` feature) is the connection extractor. Register the `SqlitePool` with `app_data(web::Data::new(pool))`.
* If a service fails without a response (for example a panicking handler), the preview is rolled back and the middleware returns an `InternalError` carrying the `500`, which Actix renders as the reply. `actix_web::test::call_service` panics on that; use `try_call_service`.

Tested with Actix Web 4.20: `cargo test -p sendproof-actix` (in-process, real SQLite) and the shared runner (`node tests/conformance/run.mjs rust-actix`).
