//! Actix Web integration for [Sendproof](https://github.com/mprync/sendproof).
//!
//! Sendproof serves an interactive workbench for your OpenAPI document under `/sendproof/` and can run
//! any *declared* operation three ways: a normal Send, an Observed Send (`Prefer: trace`, which
//! commits and returns a trace), and a Preview, which is dispatched in-process through your real
//! application, runs inside a transaction that is rolled back, and is reported as a confirmed envelope.
//!
//! It is **off by default**: nothing is served unless the configured environment is listed in
//! [`ConfigBuilder::enable_in`](sendproof_core::ConfigBuilder::enable_in).
//!
//! # Wiring
//!
//! ```no_run
//! use actix_web::{App, web};
//! use sendproof_actix::{Config, Sendproof};
//!
//! # async fn create_item() -> &'static str { "" }
//! # async fn authorize(req: actix_web::dev::ServiceRequest, next: actix_web::middleware::Next<impl actix_web::body::MessageBody>)
//! #     -> Result<actix_web::dev::ServiceResponse<impl actix_web::body::MessageBody>, actix_web::Error> { next.call(req).await }
//! let bench = Sendproof::new(
//!     Config::builder("Inventory")
//!         .environment("Development")
//!         .enable_in(["Development"])
//!         .preview_operation("POST", "/items")
//!         .build()
//!         .unwrap(),
//! );
//!
//! let bench_for_app = bench.clone();
//! let app = move || {
//!     App::new()
//!         // Outermost: mounts /sendproof and dispatches previews.
//!         .wrap(bench_for_app.middleware())
//!         .service(
//!             web::scope("")
//!                 // Outer to the gate, so authorization runs before a preview is enrolled.
//!                 .wrap(actix_web::middleware::from_fn(authorize))
//!                 .service(web::resource("/items").wrap(bench_for_app.gate()).route(web::post().to(create_item))),
//!         )
//! };
//! # let _ = app;
//! ```
//!
//! # Middleware order
//!
//! Actix runs the **last** `wrap` first. Put the gate on the resource, and authentication and
//! authorization on an enclosing scope, so they wrap it. The gate enrolls the request in the
//! preview only after it has been authorized. Authorization performed in handler extractors is not
//! enough: a preview rejected there would already have begun its transaction.

use std::{future::ready, panic::AssertUnwindSafe, rc::Rc, sync::Arc, time::Instant};

use actix_web::{
    Error, HttpMessage, HttpResponse,
    body::{BoxBody, MessageBody, to_bytes_limited},
    dev::{Service, ServiceRequest, ServiceResponse, Transform, forward_ready},
    http::{
        StatusCode, Uri,
        header::{self, HeaderMap, HeaderName, HeaderValue},
    },
};
use futures_util::{FutureExt, future::LocalBoxFuture};
pub use sendproof_core::{Config, ConfigBuilder, ConfigError, Identity, SendproofLayer, detached};
use sendproof_core::{Core, Failure, Headers, Inner, Ordinary, PreviewRequired, PreviewState, Reply, Route, capture, limits};

/// Sendproof for one Actix Web application. Cheap to clone.
#[derive(Clone)]
pub struct Sendproof {
    core: Arc<Core>,
}

impl Sendproof {
    /// Creates Sendproof from a validated configuration.
    pub fn new(config: Config) -> Self {
        Self { core: Core::for_framework(config, "Actix Web") }
    }

    /// The configuration.
    pub fn config(&self) -> &Config {
        self.core.config()
    }

    /// Rolls back held Preview sessions after the HTTP server finishes graceful shutdown.
    pub async fn shutdown_sessions(&self) {
        self.core.shutdown_sessions().await;
    }

    /// The outermost middleware: mounts `{path_base}/sendproof`, handles `{path_base}/sendproof/_preview/...`
    /// and forwards every other request. When Sendproof is disabled the workbench and previews answer
    /// as if they did not exist. Add it with `App::wrap`.
    pub fn middleware(&self) -> SendproofMiddleware {
        SendproofMiddleware { core: self.core.clone() }
    }

    /// The gate for a resource or scope. It enrolls the declared operation in a preview or an
    /// observed send once the request has been authorized. See the crate documentation for the order.
    pub fn gate(&self) -> SendproofGate {
        SendproofGate { core: self.core.clone() }
    }
}

/// Marks a normal request that asked for an observed send.
#[derive(Clone, Copy)]
struct ObservedMarker {
    started: Instant,
}

/// Copies an Actix header map into the framework-neutral form.
fn headers_of(map: &HeaderMap) -> Headers {
    map.iter().map(|(name, value)| (name.as_str().to_owned(), String::from_utf8_lossy(value.as_bytes()).into_owned())).collect()
}

/// Converts a neutral reply into an Actix response.
fn respond(reply: Reply) -> HttpResponse {
    let mut response = HttpResponse::build(StatusCode::from_u16(reply.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR));
    for (name, value) in reply.headers {
        response.append_header((name, value));
    }
    response.body(reply.body)
}

/// The outermost middleware. See [`Sendproof::middleware`].
pub struct SendproofMiddleware {
    core: Arc<Core>,
}

impl<S, B> Transform<S, ServiceRequest> for SendproofMiddleware
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error> + 'static,
    B: MessageBody + 'static,
{
    type Response = ServiceResponse<BoxBody>;
    type Error = Error;
    type Transform = BenchService<S>;
    type InitError = ();
    type Future = std::future::Ready<Result<Self::Transform, Self::InitError>>;

    fn new_transform(&self, service: S) -> Self::Future {
        ready(Ok(BenchService { service: Rc::new(service), core: self.core.clone() }))
    }
}

/// The service created by [`SendproofMiddleware`].
pub struct BenchService<S> {
    service: Rc<S>,
    core: Arc<Core>,
}

impl<S, B> Service<ServiceRequest> for BenchService<S>
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error> + 'static,
    B: MessageBody + 'static,
{
    type Response = ServiceResponse<BoxBody>;
    type Error = Error;
    type Future = LocalBoxFuture<'static, Result<Self::Response, Self::Error>>;

    forward_ready!(service);

    fn call(&self, request: ServiceRequest) -> Self::Future {
        let service = self.service.clone();
        let core = self.core.clone();
        Box::pin(async move { handle(core, service, request).await })
    }
}

async fn handle<S, B>(core: Arc<Core>, service: Rc<S>, mut request: ServiceRequest) -> Result<ServiceResponse<BoxBody>, Error>
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error> + 'static,
    B: MessageBody + 'static,
{
    let started = Instant::now();
    let path = request.path().to_owned();
    let method = request.method().as_str().to_owned();
    let headers = headers_of(request.headers());
    match core.classify(&path) {
        Route::Preview { target } => {
            let target = target.to_owned();
            preview(core, service, request, &method, &headers, &target, started).await
        }
        Route::Workbench { rest } => {
            let reply = core.workbench(&method, rest, request.uri().query(), &headers).await;
            Ok(request.into_response(respond(reply)))
        }
        Route::Session { tail } => {
            let body = if method == "POST" && tail.ends_with("/rewind") {
                let payload = request.extract::<actix_web::web::Payload>().await?;
                payload.to_bytes_limited(limits::REWIND_BODY_BYTES).await.ok().and_then(Result::ok).unwrap_or_default()
            } else {
                Default::default()
            };
            let reply = core.session_request(&method, tail, &headers, &body).await;
            Ok(request.into_response(respond(reply)))
        }
        Route::Ordinary => match core.check_ordinary(&method, &headers) {
            Ordinary::Reject(reply) => Ok(request.into_response(respond(reply))),
            other => {
                if matches!(other, Ordinary::Observe) {
                    request.extensions_mut().insert(ObservedMarker { started });
                }
                // Not a Preview: the store hooks attribute this request's writes to it, never to an open Preview.
                sendproof_core::detached(service.call(request)).await.map(ServiceResponse::map_into_boxed_body)
            }
        },
    }
}

/// `{base}/sendproof/_preview{target}`: validate, dispatch in-process, roll back, report.
async fn preview<S, B>(
    core: Arc<Core>,
    service: Rc<S>,
    mut request: ServiceRequest,
    method: &str,
    headers: &Headers,
    target: &str,
    started: Instant,
) -> Result<ServiceResponse<BoxBody>, Error>
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error> + 'static,
    B: MessageBody + 'static,
{
    let (rewritten, state) = match core.prepare_preview(method, headers, target, started).await {
        Ok(prepared) => prepared,
        Err(reply) => return Ok(request.into_response(respond(reply))),
    };
    let path_and_query = match request.uri().query() {
        Some(query) => format!("{rewritten}?{query}"),
        None => rewritten,
    };
    let Ok(uri) = path_and_query.parse::<Uri>() else {
        return Ok(request.into_response(respond(Reply::problem(400, "The Sendproof preview target is invalid."))));
    };
    // The router matches on `match_info`, which was built from the original URI.
    request.head_mut().uri = uri.clone();
    request.match_info_mut().get_mut().update(&uri);
    request.headers_mut().remove(header::ACCEPT_ENCODING);
    request.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache, no-store"));

    request.extensions_mut().insert(state.clone());
    request.extensions_mut().insert(PreviewRequired { rollback: true });
    // The router needs the only reference to the request while it routes, so the request that the
    // final response is attached to is taken from the inner response afterwards.
    let mut http_request = None;

    let dispatch = async {
        let response = match service.call(request).await {
            Ok(response) => {
                let (inner_request, response) = response.map_into_boxed_body().into_parts();
                http_request = Some(inner_request);
                response
            }
            Err(error) => error.error_response(),
        };
        let (status, response_headers) = (response.status().as_u16(), headers_of(response.headers()));
        match to_bytes_limited(response.into_body(), limits::PREVIEW_BODY_BYTES).await {
            Ok(Ok(body)) => Ok(Inner { status, headers: response_headers, body: body.to_vec() }),
            Ok(Err(error)) => Err(Failure::Error(error.to_string())),
            Err(_) => Err(Failure::TooLarge),
        }
    };
    let result = match AssertUnwindSafe(capture::scope(state.recorder(), dispatch)).catch_unwind().await {
        Ok(result) => result,
        Err(_) => Err(Failure::Error("the handler panicked".into())),
    };
    let reply = respond(state.finish(result).await);
    match http_request {
        Some(http_request) => Ok(ServiceResponse::new(http_request, reply)),
        // The service failed before a response existed. Actix turns this error into the reply.
        None => Err(actix_web::error::InternalError::from_response("Sendproof preview", reply).into()),
    }
}

/// The gate. See [`Sendproof::gate`].
pub struct SendproofGate {
    core: Arc<Core>,
}

impl<S, B> Transform<S, ServiceRequest> for SendproofGate
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error> + 'static,
    B: MessageBody + 'static,
{
    type Response = ServiceResponse<BoxBody>;
    type Error = Error;
    type Transform = GateService<S>;
    type InitError = ();
    type Future = std::future::Ready<Result<Self::Transform, Self::InitError>>;

    fn new_transform(&self, service: S) -> Self::Future {
        ready(Ok(GateService { service: Rc::new(service), core: self.core.clone() }))
    }
}

/// The service created by [`SendproofGate`].
pub struct GateService<S> {
    service: Rc<S>,
    core: Arc<Core>,
}

impl<S, B> Service<ServiceRequest> for GateService<S>
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error> + 'static,
    B: MessageBody + 'static,
{
    type Response = ServiceResponse<BoxBody>;
    type Error = Error;
    type Future = LocalBoxFuture<'static, Result<Self::Response, Self::Error>>;

    forward_ready!(service);

    fn call(&self, request: ServiceRequest) -> Self::Future {
        let service = self.service.clone();
        let core = self.core.clone();
        Box::pin(async move { gate(core, service, request).await })
    }
}

async fn gate<S, B>(core: Arc<Core>, service: Rc<S>, request: ServiceRequest) -> Result<ServiceResponse<BoxBody>, Error>
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error> + 'static,
    B: MessageBody + 'static,
{
    let preview = request.extensions().get::<Arc<PreviewState>>().cloned();
    if let Some(state) = preview {
        let (method, pattern, headers) = (request.method().as_str().to_owned(), request.match_pattern(), headers_of(request.headers()));
        return match state.enroll(&core, &method, pattern.as_deref(), &headers).await {
            Ok(enrollment) => {
                request.extensions_mut().insert(enrollment);
                let response = service.call(request).await?;
                state.complete();
                Ok(response.map_into_boxed_body())
            }
            Err(status) => {
                let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
                Ok(request.into_response(HttpResponse::new(status)))
            }
        };
    }

    let marker = request.extensions().get::<ObservedMarker>().copied();
    if let Some(marker) = marker {
        let method = request.method().as_str().to_owned();
        let declared = request.match_pattern().is_some_and(|pattern| core.is_declared(&method, &pattern));
        let send = if declared { core.begin_observed(&headers_of(request.headers()), marker.started).await } else { None };
        if let Some(send) = send {
            request.extensions_mut().insert(send.enrollment());
            let mut response = capture::scope(send.recorder(), service.call(request)).await?;
            for (name, value) in send.finish().await {
                if let (Ok(name), Ok(value)) = (HeaderName::try_from(name), HeaderValue::from_str(&value)) {
                    response.headers_mut().insert(name, value);
                }
            }
            return Ok(response.map_into_boxed_body());
        }
    }
    service.call(request).await.map(ServiceResponse::map_into_boxed_body)
}
