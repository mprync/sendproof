# sendproof-axum

Axum integration for Sendproof. See the [Rust overview](../README.md) for the quick start and safety model.

```rust
let bench = Sendproof::new(config);
let api = Router::new()
    .route("/items", post(create_item))
    .bench_gate(&bench)            // innermost
    .route_layer(auth_layer);      // wraps the gate
let app = bench.wrap(api);         // outermost: mounts /sendproof and dispatches previews
```

* `bench.wrap(app)` handles `{path_base}/sendproof/**` and `{path_base}/sendproof/_preview/**` and forwards everything else. Mount your own router at the same `path_base` (for example `Router::nest`).
* A preview is rewritten to the original path and dispatched **in-process** through `app`, so routing, middleware and extractors are the real ones. The response is buffered (max 1 MiB) and wrapped in the confirmed envelope after a successful rollback.
* `bench_gate` enrolls the routes added so far. **Add it before your authentication layers**, so a preview is only enrolled after authorization. Authorizing inside handler extractors is not enough.
* Declared operations use Axum route templates relative to the mount (`/items/{id}`), compared with `MatchedPath`.
* Preview targets that are not declared (including unknown paths) answer `409`; the HTTP redirect, cookie and hop-by-hop headers of the inner response are never forwarded.

Tested with Axum 0.8. Disabled, no-provider and rollback-failure behavior is covered by the conformance runner (`node tests/conformance/run.mjs rust-axum`). Actix Web is not implemented yet.
