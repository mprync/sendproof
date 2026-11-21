//! The framework-neutral half of the transport.
//!
//! A framework adapter classifies the request path, hands the checks and the post-dispatch logic to
//! [`Core`], and only has to do what is framework specific: rewrite the URI, dispatch the request
//! in-process through the real router, buffer the response, and translate a [`Reply`].

use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};

use http::Extensions;
use uuid::Uuid;

use crate::{
    assets,
    capture::{self, Recorder},
    config::{Config, Identity},
    headers::Headers,
    limits,
    model::{ObservedTrace, PreviewEnvelope},
    protocol,
    provider::{Observation, PreviewRequired, PreviewSession},
    trace_store::{Reservation, TraceOwner, TraceStore},
};

/// A response produced by Test Bench itself.
#[derive(Debug, Clone)]
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}

impl Reply {
    /// An empty response.
    pub fn empty(status: u16) -> Self {
        Self { status, headers: Vec::new(), body: Vec::new() }
    }

    /// An `application/problem+json` response that is never cached.
    pub fn problem(status: u16, title: &str) -> Self {
        let (status, body) = protocol::problem(status, title);
        Self { status, headers: vec![("content-type", "application/problem+json".into()), ("cache-control", "no-store".into())], body }
    }

    fn json(status: u16, body: Vec<u8>) -> Self {
        Self {
            status,
            headers: vec![
                ("content-type", "application/json; charset=utf-8".into()),
                ("cache-control", "no-store".into()),
                ("x-content-type-options", "nosniff".into()),
            ],
            body,
        }
    }

    fn with(mut self, name: &'static str, value: impl Into<String>) -> Self {
        self.headers.push((name, value.into()));
        self
    }
}

/// What a request path means to Test Bench.
#[derive(Debug, PartialEq, Eq)]
pub enum Route<'a> {
    /// `{base}/bench/_preview{target}`: `target` is the path after the prefix.
    Preview { target: &'a str },
    /// `{base}/bench/...` while enabled. `rest` is relative to the mount and starts with `/bench`.
    Workbench { rest: &'a str },
    /// Anything else, forwarded to the application.
    Ordinary,
}

/// The handling of an ordinary request.
#[derive(Debug)]
pub enum Ordinary {
    /// Answer with this reply instead of dispatching.
    Reject(Reply),
    /// Dispatch, and mark the request as asking for an observed send.
    Observe,
    /// Dispatch unchanged.
    Pass,
}

/// A failure while dispatching a preview.
#[derive(Debug)]
pub enum Failure {
    /// The inner response exceeded the 1 MiB preview limit.
    TooLarge,
    /// Any other failure, with a message for the log.
    Error(String),
}

/// The buffered response of the application to a preview.
#[derive(Debug)]
pub struct Inner {
    pub status: u16,
    pub headers: Headers,
    pub body: Vec<u8>,
}

/// What a provider put in place for the handler. Adapters store it in their request extensions.
#[derive(Clone)]
pub struct Enrollment(pub Arc<Extensions>);

/// Shared state of one Test Bench instance: configuration and traces.
pub struct Core {
    config: Config,
    traces: TraceStore,
}

fn has_prefix(path: &str, prefix: &str) -> bool {
    path.get(..prefix.len()).is_some_and(|head| head.eq_ignore_ascii_case(prefix))
        && (path.len() == prefix.len() || path.as_bytes()[prefix.len()] == b'/')
}

impl Core {
    /// Creates the shared state.
    pub fn new(config: Config) -> Arc<Self> {
        let traces = TraceStore::new(config.trace_retention());
        Arc::new(Self { config, traces })
    }

    /// The configuration.
    pub fn config(&self) -> &Config {
        &self.config
    }

    /// Classifies a request path (without its query).
    pub fn classify<'a>(&self, path: &'a str) -> Route<'a> {
        let base = self.config.path_base();
        let relative =
            if base.is_empty() { Some(path) } else { path.strip_prefix(base).filter(|rest| rest.is_empty() || rest.starts_with('/')) };
        match relative {
            Some(rest) if has_prefix(rest, protocol::PREVIEW_PREFIX) => Route::Preview { target: &rest[protocol::PREVIEW_PREFIX.len()..] },
            Some(rest) if self.config.enabled() && has_prefix(rest, protocol::WORKBENCH_PREFIX) => Route::Workbench { rest },
            _ => Route::Ordinary,
        }
    }

    /// Checks an ordinary request: a rollback preference outside the preview URL is rejected, and
    /// `Prefer: trace` on a same-origin, non-HEAD request asks for an observed send.
    pub fn check_ordinary(&self, method: &str, headers: &Headers) -> Ordinary {
        if protocol::requests_rollback(headers) {
            return Ordinary::Reject(Reply::problem(400, "Use the Test Bench preview URL for rollback requests."));
        }
        let observe = self.config.enabled()
            && !method.eq_ignore_ascii_case("HEAD")
            && protocol::requests_trace(headers)
            && protocol::is_same_origin(headers);
        if observe { Ordinary::Observe } else { Ordinary::Pass }
    }

    /// Validates a preview request before it is dispatched. On success returns the rewritten path
    /// (the target under the mount), to which the adapter appends the original query.
    ///
    /// A preview can never reach a route that was not declared: the data layer would otherwise
    /// commit for real. Unknown and undeclared targets look the same to the caller.
    pub fn check_preview(&self, method: &str, headers: &Headers, target: &str) -> Result<String, Reply> {
        if !self.config.enabled() {
            return Err(Reply::problem(404, "Test Bench previews are unavailable."));
        }
        if !protocol::has_exact_preference(headers) {
            return Err(Reply::problem(400, "A Test Bench preview requires Prefer: tx=rollback."));
        }
        if method.eq_ignore_ascii_case("HEAD") {
            return Err(Reply::problem(405, "A preview requires a response body."));
        }
        if !protocol::is_valid_target(target) {
            return Err(Reply::problem(400, "The Test Bench preview target is invalid."));
        }
        if !protocol::is_same_origin(headers) {
            return Err(Reply::problem(403, "A preview must be requested from the same origin."));
        }
        if self.config.available_provider().is_none() {
            return Err(Reply::problem(503, "Preview requires one available preview provider."));
        }
        if !self.config.matches_operation(method, target) {
            return Err(Reply::problem(409, "This operation is unavailable for preview."));
        }
        Ok(format!("{}{}", self.config.path_base(), target))
    }

    /// Whether the matched route template (including the mount) and method are declared for preview.
    pub fn is_declared(&self, method: &str, matched_pattern: &str) -> bool {
        let relative = matched_pattern.strip_prefix(self.config.path_base()).unwrap_or(matched_pattern);
        self.config.is_preview_operation(method, relative)
    }

    /// Serves `{base}/bench/**`. `rest` is the path relative to the mount, starting with `/bench`.
    pub async fn workbench(&self, method: &str, rest: &str, query: Option<&str>, headers: &Headers) -> Reply {
        let identity = self.config.identify(headers).await;
        if !self.config.admits(identity.as_ref()) {
            return match identity {
                None => Reply::problem(401, "Sign in to use the workbench."),
                Some(_) => Reply::problem(403, "This account may not use the workbench."),
            };
        }
        let head = method.eq_ignore_ascii_case("HEAD");
        if !head && !method.eq_ignore_ascii_case("GET") {
            return Reply::empty(405).with("allow", "GET, HEAD");
        }
        let strip = |reply: Reply| if head { Reply { body: Vec::new(), ..reply } } else { reply };
        let tail = &rest[protocol::WORKBENCH_PREFIX.len()..];
        match tail {
            "" => {
                let query = query.map(|q| format!("?{q}")).unwrap_or_default();
                Reply::empty(302).with("location", format!("{}/bench/{query}", self.config.path_base()))
            }
            "/" | "/signin.html" => strip(self.asset("index.html")),
            "/_api/capabilities" => {
                let document = protocol::capabilities(&self.config, identity.as_ref());
                strip(Reply::json(200, serde_json::to_vec(&document).unwrap_or_default()))
            }
            _ if tail.starts_with("/_api/traces/") => {
                let id = Uuid::parse_str(&tail["/_api/traces/".len()..]).ok();
                let owner = identity.as_ref().and_then(|identity| self.owner_of(identity));
                let (Some(id), Some(owner), true) = (id, owner, protocol::is_same_origin(headers)) else {
                    return Reply::json(404, Vec::new());
                };
                match self.traces.read(id, &owner).await {
                    Some(trace) => strip(Reply::json(200, serde_json::to_vec(&*trace).unwrap_or_default())),
                    None => Reply::json(404, Vec::new()),
                }
            }
            _ if tail.starts_with("/_api/") => Reply::empty(404),
            _ => strip(self.asset(&tail[1..])),
        }
    }

    fn asset(&self, path: &str) -> Reply {
        if !assets::available() {
            return Reply::problem(503, "The workbench UI is not embedded in this build.");
        }
        match assets::get(path) {
            Some(found) => Reply {
                status: 200,
                headers: vec![
                    ("content-type", found.content_type.into()),
                    ("cache-control", "no-cache".into()),
                    ("x-content-type-options", "nosniff".into()),
                ],
                body: found.bytes.to_vec(),
            },
            None => Reply::empty(404),
        }
    }

    /// The owner of a trace: an identity with an issued, stable subject.
    fn owner_of(&self, identity: &Identity) -> Option<TraceOwner> {
        let subject = identity.subject.as_ref().filter(|s| !s.is_empty() && s.len() <= 256)?;
        Some(TraceOwner {
            authentication_type: identity.authentication_type.clone().unwrap_or_default(),
            subject: subject.clone(),
            path_base: self.config.path_base().to_owned(),
        })
    }

    /// Begins an observed send when the caller is an authenticated, admitted identity with a stable
    /// subject and an available provider can observe. Returns `None` to run the request normally.
    pub async fn begin_observed(self: &Arc<Self>, headers: &Headers, started: Instant) -> Option<ObservedSend> {
        let identity = self.config.identify(headers).await;
        let owner = identity.as_ref().and_then(|identity| self.owner_of(identity))?;
        if !self.config.admits(identity.as_ref()) {
            return None;
        }
        let provider = self.config.available_provider()?.clone();
        // The provider reads the current recorder while it begins, so scope it first.
        let recorder = Recorder::new(started, self.config.show_sql_values());
        let mut extensions = Extensions::new();
        let began = capture::scope(recorder.clone(), provider.begin_observation(&mut extensions)).await;
        let observation = match began {
            Ok(Some(observation)) => observation,
            Ok(None) => return None,
            Err(error) => {
                tracing::warn!(%error, "Test Bench could not start observing the send");
                return None;
            }
        };
        let reservation = self.traces.reserve(owner);
        recorder.start_handler();
        recorder.begin(false);
        Some(ObservedSend {
            core: self.clone(),
            recorder,
            reservation,
            observation: Some(observation),
            enrollment: Enrollment(Arc::new(extensions)),
            armed: true,
        })
    }
}

/// An observed send in progress. Dropping it unfinished discards the reserved trace.
pub struct ObservedSend {
    core: Arc<Core>,
    recorder: Arc<Recorder>,
    reservation: Reservation,
    observation: Option<Box<dyn Observation>>,
    enrollment: Enrollment,
    armed: bool,
}

impl ObservedSend {
    /// The recorder to scope around the handler with [`capture::scope`].
    pub fn recorder(&self) -> Arc<Recorder> {
        self.recorder.clone()
    }

    /// What the provider put in place for the handler.
    pub fn enrollment(&self) -> Enrollment {
        self.enrollment.clone()
    }

    /// Stores the trace and returns the headers to add to the response.
    pub async fn finish(mut self) -> Vec<(&'static str, String)> {
        self.recorder.end_handler();
        let snapshot = self.recorder.finish();
        let mut incomplete = false;
        if let Some(observation) = self.observation.as_mut()
            && let Err(error) = observation.complete().await
        {
            tracing::warn!(%error, "Test Bench could not collect the observed changes");
            incomplete = true;
        }
        let serialize = Instant::now();
        let provider_changes = self.observation.as_mut().map(|o| o.changes()).unwrap_or_default();
        let (changes, truncated) = limits::snapshot_changes(&provider_changes.changes);
        let timing = self.recorder.timing(serialize.elapsed().as_secs_f64() * 1000.0);
        self.core.traces.complete(
            self.reservation,
            ObservedTrace {
                changes,
                effects: snapshot.effects,
                logs: snapshot.logs,
                timing,
                changes_truncated: truncated || provider_changes.truncated || incomplete,
                effects_truncated: snapshot.effects_truncated,
                logs_truncated: snapshot.logs_truncated,
            },
        );
        self.armed = false;
        if let Some(observation) = self.observation.take()
            && let Err(error) = observation.close().await
        {
            tracing::warn!(%error, "Test Bench could not release the send observation");
        }
        vec![
            (protocol::TRACE_HEADER, self.reservation.id.simple().to_string()),
            ("cache-control", "no-store".into()),
            ("server-timing", timing.server_timing()),
        ]
    }
}

impl Drop for ObservedSend {
    fn drop(&mut self) {
        if self.armed {
            self.core.traces.discard(self.reservation);
        }
    }
}

/// The state of one preview, shared by the adapter's outer transport and its gate.
pub struct PreviewState {
    invoked: AtomicBool,
    completed: AtomicBool,
    session: Mutex<Option<Box<dyn PreviewSession>>>,
    recorder: Arc<Recorder>,
}

/// The marker adapters insert before dispatch so a data layer can refuse an unenrolled preview.
pub const PREVIEW_REQUIRED: PreviewRequired = PreviewRequired { rollback: true };

impl PreviewState {
    /// Creates the state for a preview that started at `started`.
    pub fn new(core: &Core, started: Instant) -> Arc<Self> {
        let recorder = Recorder::new(started, core.config.show_sql_values());
        Arc::new(Self { invoked: AtomicBool::new(false), completed: AtomicBool::new(false), session: Mutex::new(None), recorder })
    }

    /// The recorder to scope around the dispatch with [`capture::scope`].
    pub fn recorder(&self) -> Arc<Recorder> {
        self.recorder.clone()
    }

    /// Whether the handler's gate has been entered.
    pub fn invoked(&self) -> bool {
        self.invoked.load(Ordering::SeqCst)
    }

    /// Marks the handler as finished without panicking.
    pub fn complete(&self) {
        self.completed.store(true, Ordering::SeqCst);
    }

    /// Called by the gate after authorization: checks the request, begins the provider's session and
    /// starts recording. Returns the enrollment to store in the request, or the status to answer with.
    pub async fn enroll(&self, core: &Core, method: &str, matched_pattern: Option<&str>, headers: &Headers) -> Result<Enrollment, u16> {
        if !matched_pattern.is_some_and(|pattern| core.is_declared(method, pattern)) || self.invoked() {
            return Err(409);
        }
        if !protocol::is_same_origin(headers) {
            return Err(403);
        }
        let Some(provider) = core.config.available_provider().cloned() else { return Err(503) };
        self.invoked.store(true, Ordering::SeqCst);
        self.recorder.start_handler();
        let mut extensions = Extensions::new();
        match provider.begin_preview(&mut extensions).await {
            Ok(session) => *self.session.lock().unwrap_or_else(|p| p.into_inner()) = Some(session),
            Err(error) => {
                tracing::error!(%error, "the preview provider could not begin a session");
                return Err(500);
            }
        }
        self.recorder.begin(true);
        Ok(Enrollment(Arc::new(extensions)))
    }

    /// Rolls the preview back and builds the reply: the confirmed envelope, or a rejection.
    ///
    /// The envelope is produced only when the handler ran to completion, nothing failed, and the
    /// rollback succeeded. The session is always closed.
    pub async fn finish(&self, result: Result<Inner, Failure>) -> Reply {
        self.recorder.end_handler();
        let mut result = result;
        let session = self.session.lock().unwrap_or_else(|p| p.into_inner()).take();
        let mut envelope = None;
        if let Some(mut session) = session {
            match session.rollback().await {
                Ok(()) => {
                    if let (Ok(inner), true) = (&result, self.completed.load(Ordering::SeqCst)) {
                        let snapshot = self.recorder.finish();
                        let provider_changes = session.changes();
                        let (changes, truncated) = limits::snapshot_changes(&provider_changes.changes);
                        envelope = Some(protocol::build_envelope(
                            inner.status,
                            &inner.headers,
                            &inner.body,
                            (changes, truncated || provider_changes.truncated),
                            snapshot.effects,
                            snapshot.logs,
                            snapshot.effects_truncated,
                            snapshot.logs_truncated,
                        ));
                    }
                }
                Err(error) => result = Err(Failure::Error(format!("rollback failed: {error}"))),
            }
            self.recorder.finish();
            if let Err(error) = session.close().await {
                result = Err(Failure::Error(format!("closing the preview failed: {error}")));
            }
        }
        self.recorder.finish();

        match result {
            Err(Failure::TooLarge) => Reply::problem(413, "The preview response exceeds the 1 MiB limit."),
            Err(Failure::Error(message)) => {
                tracing::error!(%message, "a Test Bench preview failed");
                Reply::problem(500, "The preview could not be completed safely.")
            }
            Ok(inner) => match envelope {
                Some(envelope) => self.confirmed(&envelope),
                None if self.invoked() => Reply::problem(500, "The preview operation did not finish."),
                None => {
                    let (status, title) = protocol::reject_unexecuted(inner.status);
                    let mut reply = Reply::problem(status, title);
                    if let Some(challenge) = inner.headers.get("www-authenticate") {
                        reply.headers.push(("www-authenticate", challenge.to_owned()));
                    }
                    reply
                }
            },
        }
    }

    fn confirmed(&self, envelope: &PreviewEnvelope) -> Reply {
        let serialize = Instant::now();
        let body = serde_json::to_vec(envelope).unwrap_or_default();
        let timing = self.recorder.timing(serialize.elapsed().as_secs_f64() * 1000.0);
        Reply {
            status: 200,
            headers: vec![
                ("content-type", "application/json; charset=utf-8".into()),
                ("cache-control", "no-store".into()),
                ("preference-applied", protocol::ROLLBACK_PREFERENCE.into()),
                ("server-timing", timing.server_timing()),
            ],
            body,
        }
    }
}
