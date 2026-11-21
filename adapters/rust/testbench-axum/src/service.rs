//! The outermost service: mounts the workbench and runs previews through the real router.

use std::{
    convert::Infallible,
    future::Future,
    panic::AssertUnwindSafe,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Instant,
};

use axum::{Router, body::Body, extract::Request, response::Response};
use futures_util::FutureExt;
use http::{HeaderName, HeaderValue, StatusCode, header};
use http_body_util::{BodyExt, Limited};
use testbench_core::{Config, Core, Failure, Headers, Inner, Ordinary, PreviewRequired, PreviewState, Reply, Route, capture, limits};
use tower::ServiceExt;

/// Test Bench for one Axum application. Cheap to clone.
#[derive(Clone)]
pub struct TestBench {
    pub(crate) core: Arc<Core>,
}

impl TestBench {
    /// Creates Test Bench from a validated configuration.
    pub fn new(config: Config) -> Self {
        Self { core: Core::new(config) }
    }

    /// The configuration.
    pub fn config(&self) -> &Config {
        self.core.config()
    }

    /// Wraps the finished application. Serve the returned router.
    ///
    /// The wrapper mounts the workbench at `{path_base}/bench`, handles `{path_base}/bench/_preview/...`
    /// and forwards every other request to `app`. When Test Bench is disabled the workbench and
    /// previews answer as if they did not exist.
    pub fn wrap(&self, app: Router) -> Router {
        Router::new().fallback_service(BenchService { bench: self.clone(), app })
    }
}

/// Marks a normal request that asked for an observed send.
#[derive(Clone, Copy)]
pub(crate) struct ObservedMarker {
    pub(crate) started: Instant,
}

#[derive(Clone)]
struct BenchService {
    bench: TestBench,
    app: Router,
}

impl tower::Service<Request> for BenchService {
    type Response = Response;
    type Error = Infallible;
    type Future = Pin<Box<dyn Future<Output = Result<Response, Infallible>> + Send>>;

    fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, request: Request) -> Self::Future {
        let service = self.clone();
        Box::pin(async move { Ok(service.handle(request).await) })
    }
}

/// Converts a framework-neutral reply into an Axum response.
pub(crate) fn respond(reply: Reply) -> Response {
    let mut response = Response::new(Body::from(reply.body));
    *response.status_mut() = StatusCode::from_u16(reply.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    for (name, value) in reply.headers {
        if let (Ok(name), Ok(value)) = (HeaderName::try_from(name), HeaderValue::from_str(&value)) {
            response.headers_mut().append(name, value);
        }
    }
    response
}

impl BenchService {
    async fn handle(&self, request: Request) -> Response {
        let path = request.uri().path().to_owned();
        match self.bench.core.classify(&path) {
            Route::Preview { target } => {
                let target = target.to_owned();
                self.preview(request, target).await
            }
            Route::Workbench { rest } => {
                let rest = rest.to_owned();
                let headers = Headers::from(request.headers());
                respond(self.bench.core.workbench(request.method().as_str(), &rest, request.uri().query(), &headers).await)
            }
            Route::Ordinary => self.ordinary(request).await,
        }
    }

    /// A request outside the reserved routes: forwarded, optionally marked for an observed send.
    async fn ordinary(&self, mut request: Request) -> Response {
        let started = Instant::now();
        match self.bench.core.check_ordinary(request.method().as_str(), &Headers::from(request.headers())) {
            Ordinary::Reject(reply) => return respond(reply),
            Ordinary::Observe => {
                request.extensions_mut().insert(ObservedMarker { started });
            }
            Ordinary::Pass => {}
        }
        self.app.clone().oneshot(request).await.unwrap_or_else(|never| match never {})
    }

    /// `{base}/bench/_preview{target}`: validate, dispatch in-process, roll back, report.
    async fn preview(&self, mut request: Request, target: String) -> Response {
        let core = &self.bench.core;
        let started = Instant::now();
        let rewritten = match core.check_preview(request.method().as_str(), &Headers::from(request.headers()), &target) {
            Ok(path) => path,
            Err(reply) => return respond(reply),
        };
        let path_and_query = match request.uri().query() {
            Some(query) => format!("{rewritten}?{query}"),
            None => rewritten,
        };
        let Ok(uri) = path_and_query.parse::<http::Uri>() else {
            return respond(Reply::problem(400, "The Test Bench preview target is invalid."));
        };
        *request.uri_mut() = uri;
        let headers = request.headers_mut();
        headers.remove(header::ACCEPT_ENCODING);
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache, no-store"));

        let state = PreviewState::new(core, started);
        request.extensions_mut().insert(state.clone());
        request.extensions_mut().insert(PreviewRequired { rollback: true });

        let app = self.app.clone();
        let dispatch = async move {
            let response = app.oneshot(request).await.unwrap_or_else(|never| match never {});
            let (parts, body) = response.into_parts();
            match Limited::new(body, limits::PREVIEW_BODY_BYTES).collect().await {
                Ok(collected) => {
                    Ok(Inner { status: parts.status.as_u16(), headers: Headers::from(&parts.headers), body: collected.to_bytes().to_vec() })
                }
                Err(error) if error.downcast_ref::<http_body_util::LengthLimitError>().is_some() => Err(Failure::TooLarge),
                Err(error) => Err(Failure::Error(error.to_string())),
            }
        };
        let result = match AssertUnwindSafe(capture::scope(state.recorder(), dispatch)).catch_unwind().await {
            Ok(result) => result,
            Err(_) => Err(Failure::Error("the handler panicked".into())),
        };
        respond(state.finish(result).await)
    }
}
