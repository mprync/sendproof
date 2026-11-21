//! Minimal consumer for the crates.io smoke test: an Axum app serving the Sendproof workbench at /sendproof/
//! (environment Development) and an OpenAPI document at /openapi.json, on 127.0.0.1:$PORT.

use axum::{Json, Router, routing::get};
use serde_json::{Value, json};
use sendproof_axum::{Config, Sendproof};

async fn openapi() -> Json<Value> {
    Json(json!({
        "openapi": "3.1.0",
        "info": { "title": "Consumer", "version": "1.0.0" },
        "paths": { "/ping": { "get": { "responses": { "200": { "description": "pong" } } } } }
    }))
}

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(5000);
    let bench = Sendproof::new(
        Config::builder("Consumer")
            .environment("Development")
            .enable_in(["Development"])
            .open_api_url("/openapi.json")
            .build()
            .expect("valid Sendproof configuration"),
    );
    let api = Router::new().route("/openapi.json", get(openapi)).route("/ping", get(|| async { "pong" }));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.expect("bind");
    axum::serve(listener, bench.wrap(api)).await.expect("serve");
}
