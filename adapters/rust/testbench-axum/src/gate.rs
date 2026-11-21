//! The gate: enrolls an authorized, declared operation in a preview or observed send.

use std::sync::Arc;

use axum::{
    Router,
    extract::{MatchedPath, Request, State},
    middleware::{Next, from_fn_with_state},
    response::Response,
};
use http::{HeaderName, HeaderValue, StatusCode};
use testbench_core::{Headers, PreviewState, capture};

use crate::service::{ObservedMarker, TestBench};

/// Adds the Test Bench gate to a router.
pub trait TestBenchRouterExt {
    /// Enrolls the routes added **so far** in previews and observed sends.
    ///
    /// Call this before adding authentication and authorization `route_layer`s, so those layers
    /// run first and the gate only sees authorized requests. Only operations declared with
    /// [`ConfigBuilder::preview_operation`](testbench_core::ConfigBuilder::preview_operation)
    /// are enrolled; every other route answers a preview with `409`.
    fn bench_gate(self, bench: &TestBench) -> Self;
}

impl<S> TestBenchRouterExt for Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    fn bench_gate(self, bench: &TestBench) -> Self {
        self.route_layer(from_fn_with_state(bench.clone(), gate))
    }
}

async fn gate(State(bench): State<TestBench>, request: Request, next: Next) -> Response {
    if let Some(state) = request.extensions().get::<Arc<PreviewState>>().cloned() {
        return preview(&bench, state, request, next).await;
    }
    if let Some(marker) = request.extensions().get::<ObservedMarker>().copied() {
        return observed(&bench, marker, request, next).await;
    }
    next.run(request).await
}

fn matched(request: &Request) -> Option<String> {
    request.extensions().get::<MatchedPath>().map(|path| path.as_str().to_owned())
}

async fn preview(bench: &TestBench, state: Arc<PreviewState>, mut request: Request, next: Next) -> Response {
    let headers = Headers::from(request.headers());
    match state.enroll(&bench.core, request.method().as_str(), matched(&request).as_deref(), &headers).await {
        Ok(enrollment) => {
            request.extensions_mut().insert(enrollment);
            let response = next.run(request).await;
            state.complete();
            response
        }
        Err(status) => {
            let mut response = Response::new(axum::body::Body::empty());
            *response.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            response
        }
    }
}

async fn observed(bench: &TestBench, marker: ObservedMarker, mut request: Request, next: Next) -> Response {
    let declared = matched(&request).is_some_and(|pattern| bench.core.is_declared(request.method().as_str(), &pattern));
    let headers = Headers::from(request.headers());
    let send = if declared { bench.core.begin_observed(&headers, marker.started).await } else { None };
    let Some(send) = send else { return next.run(request).await };

    request.extensions_mut().insert(send.enrollment());
    let mut response = capture::scope(send.recorder(), next.run(request)).await;
    for (name, value) in send.finish().await {
        if let (Ok(name), Ok(value)) = (HeaderName::try_from(name), HeaderValue::from_str(&value)) {
            response.headers_mut().insert(name, value);
        }
    }
    response
}
