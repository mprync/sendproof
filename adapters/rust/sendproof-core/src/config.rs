//! Configuration shared by every framework adapter.

use std::{fmt, sync::Arc, time::Duration};

use crate::{
    headers::Headers,
    provider::{BoxFuture, PreviewProvider},
    stores::{DataStore, StoreDescription, StoreMode},
    trace_store::DEFAULT_RETENTION,
};

pub(crate) mod journeys;

/// The authenticated caller, as resolved by the host.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Identity {
    /// Display name shown in the workbench.
    pub name: Option<String>,
    /// Display role.
    pub role: Option<String>,
    /// A stable, issued subject (for example a user id). Required to own observed-send traces.
    pub subject: Option<String>,
    /// How the caller authenticated (for example `cookie`). Part of the trace owner.
    pub authentication_type: Option<String>,
}

/// A sign-in method advertised to the workbench.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthProvider {
    pub label: String,
    pub kind: String,
    /// Same-origin entry URL relative to the mount, or `None` for non-interactive handlers.
    pub url: Option<String>,
}

/// An OpenAPI document the workbench can load.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenApiDocument {
    pub name: String,
    pub url: String,
}

/// An operation that may run in a preview, in OpenAPI path-template form.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Operation {
    /// Upper-case HTTP verb.
    pub method: String,
    /// Path relative to the mount, using the framework's template syntax.
    pub path: String,
}

/// An operation its author marked `preview: false`: it runs normally but a Preview of it never
/// runs the handler. Listed in capabilities `previewUnavailable` with its reason.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnavailableOperation {
    /// Upper-case HTTP verb.
    pub method: String,
    /// Path relative to the mount, using the framework's template syntax.
    pub path: String,
    /// The sentence the workbench shows before the user tries.
    pub reason: String,
    /// The stores the operation writes, as store ids such as `redis`.
    pub stores: Vec<String>,
}

/// Resolves the caller from the headers of a request.
pub type IdentityResolver = Arc<dyn Fn(Headers) -> BoxFuture<'static, Option<Identity>> + Send + Sync>;
/// Decides whether a caller may use the workbench, previews and observed sends.
pub type WorkbenchPolicy = Arc<dyn Fn(Option<&Identity>) -> bool + Send + Sync>;

/// An invalid configuration value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError(pub String);

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid Sendproof configuration: {}", self.0)
    }
}

impl std::error::Error for ConfigError {}

/// Framework-neutral configuration. Build it with [`Config::builder`].
///
/// Sendproof is **off by default**. It only serves the workbench and previews when
/// the configured [`environment`](ConfigBuilder::environment) is one of the
/// [`enable_in`](ConfigBuilder::enable_in) environments.
pub struct Config {
    pub(crate) api_name: String,
    pub(crate) environment: String,
    pub(crate) enabled_in: Vec<String>,
    pub(crate) open_api_url: String,
    pub(crate) documents: Vec<OpenApiDocument>,
    pub(crate) field_modules: Vec<String>,
    pub(crate) journeys: Vec<journeys::JourneyFile>,
    pub(crate) auth_providers: Vec<AuthProvider>,
    pub(crate) include_sql_parameter_values: Option<bool>,
    pub(crate) path_base: String,
    pub(crate) trace_retention: Duration,
    pub(crate) operations: Vec<Operation>,
    pub(crate) unavailable: Vec<UnavailableOperation>,
    pub(crate) provider: Option<Arc<dyn PreviewProvider>>,
    pub(crate) stores: Vec<Arc<dyn DataStore>>,
    pub(crate) identity: Option<IdentityResolver>,
    pub(crate) policy: Option<WorkbenchPolicy>,
}

impl Config {
    /// Starts a configuration for the API called `api_name`.
    pub fn builder(api_name: impl Into<String>) -> ConfigBuilder {
        let config = Config {
            api_name: api_name.into(),
            environment: "Production".into(),
            enabled_in: Vec::new(),
            open_api_url: "/openapi/v1.json".into(),
            documents: Vec::new(),
            field_modules: Vec::new(),
            journeys: Vec::new(),
            auth_providers: Vec::new(),
            include_sql_parameter_values: None,
            path_base: String::new(),
            trace_retention: DEFAULT_RETENTION,
            operations: Vec::new(),
            unavailable: Vec::new(),
            provider: None,
            stores: Vec::new(),
            identity: None,
            policy: None,
        };
        ConfigBuilder(config, Vec::new())
    }

    /// Whether the workbench and previews are served for the configured environment.
    pub fn enabled(&self) -> bool {
        self.enabled_in.iter().any(|name| name.eq_ignore_ascii_case(&self.environment))
    }

    /// The mount prefix: empty, or a path such as `/tenant`.
    pub fn path_base(&self) -> &str {
        &self.path_base
    }

    /// The preview operations the host declared.
    pub fn operations(&self) -> &[Operation] {
        &self.operations
    }

    /// The registered provider, when it can run previews right now.
    pub fn available_provider(&self) -> Option<&Arc<dyn PreviewProvider>> {
        self.provider.as_ref().filter(|provider| provider.is_available())
    }

    /// The operations marked `preview: false`.
    pub fn unavailable_operations(&self) -> &[UnavailableOperation] {
        &self.unavailable
    }

    /// Looks up a registered journey document by the workbench route tail, such as
    /// `/journeys/example.arazzo.json`. Unknown names and suffixes return `None`.
    pub fn journey_document(&self, tail: &str) -> Option<&[u8]> {
        let name = tail.strip_prefix("/journeys/")?;
        if name.contains('/') {
            return None;
        }
        self.journeys.iter().find_map(|journey| {
            if name == format!("{}.arazzo.json", journey.name()) {
                Some(journey.arazzo())
            } else if name == format!("{}.expect.json", journey.name()) {
                Some(journey.expectations())
            } else {
                None
            }
        })
    }

    /// The registered data stores.
    pub fn data_stores(&self) -> &[Arc<dyn DataStore>] {
        &self.stores
    }

    /// Describes every registered store, for capabilities.
    pub async fn describe_stores(&self) -> Vec<StoreDescription> {
        let mut described = Vec::with_capacity(self.stores.len());
        for store in &self.stores {
            described.push(store.describe().await);
        }
        described
    }

    /// Whether a preview can run: an available SQL provider, or at least one data store. A preview
    /// needs no SQL provider when the application's only stores are hooked data stores.
    pub fn can_preview(&self) -> bool {
        self.available_provider().is_some() || !self.stores.is_empty()
    }

    /// A rollback-capable store must support holding its transaction. Guard stores hold nothing.
    pub(crate) fn can_hold_preview(&self, described: &[StoreDescription]) -> bool {
        self.enabled()
            && self.can_preview()
            && self.provider.as_ref().is_none_or(|provider| provider.is_available() && provider.supports_held_preview())
            && self.stores.len() == described.len()
            && self
                .stores
                .iter()
                .zip(described)
                .all(|(store, description)| description.mode == StoreMode::Guard || store.supports_held_preview())
    }

    /// Whether `method` and the matched route template (relative to the mount) are declared for preview.
    pub fn is_preview_operation(&self, method: &str, template: &str) -> bool {
        self.operations.iter().any(|op| op.method.eq_ignore_ascii_case(method) && op.path == template)
    }

    /// Whether `method` and `path` (relative to the mount) match a declared preview operation.
    ///
    /// Used before dispatch so a preview can never reach a route that was not declared.
    pub fn matches_operation(&self, method: &str, path: &str) -> bool {
        self.operations.iter().any(|op| op.method.eq_ignore_ascii_case(method) && template_matches(&op.path, path))
    }

    /// How long observed-send traces are retained.
    pub fn trace_retention(&self) -> Duration {
        self.trace_retention
    }

    /// Whether SQL parameter values may be shown. Defaults to `true` only in `Development`.
    pub fn show_sql_values(&self) -> bool {
        self.include_sql_parameter_values.unwrap_or_else(|| self.environment.eq_ignore_ascii_case("Development"))
    }

    /// Resolves the caller from request headers.
    pub async fn identify(&self, headers: &Headers) -> Option<Identity> {
        match &self.identity {
            Some(resolver) => resolver(headers.clone()).await,
            None => None,
        }
    }

    /// Whether the workbench policy admits `identity`. Without a policy everyone is admitted.
    pub fn admits(&self, identity: Option<&Identity>) -> bool {
        self.policy.as_ref().is_none_or(|policy| policy(identity))
    }

    /// Whether a workbench policy is configured.
    pub fn has_policy(&self) -> bool {
        self.policy.is_some()
    }

    pub(crate) fn api_name(&self) -> &str {
        &self.api_name
    }
}

/// Builds a [`Config`].
pub struct ConfigBuilder(Config, Vec<(String, journeys::GenerateJourney)>);

impl ConfigBuilder {
    /// The environment label shown in the workbench, such as `Development`. Defaults to `Production`.
    pub fn environment(mut self, name: impl Into<String>) -> Self {
        self.0.environment = name.into();
        self
    }

    /// The environments in which Sendproof is enabled. Nothing is enabled by default.
    pub fn enable_in<I, S>(mut self, environments: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.0.enabled_in = environments.into_iter().map(Into::into).collect();
        self
    }

    /// The mount prefix of the application, empty or such as `/tenant`.
    pub fn path_base(mut self, base: impl Into<String>) -> Self {
        self.0.path_base = base.into();
        self
    }

    /// The URL of the primary OpenAPI document, relative to the mount. Defaults to `/openapi/v1.json`.
    pub fn open_api_url(mut self, url: impl Into<String>) -> Self {
        self.0.open_api_url = url.into();
        self
    }

    /// Adds an additional OpenAPI document.
    pub fn document(mut self, name: impl Into<String>, url: impl Into<String>) -> Self {
        self.0.documents.push(OpenApiDocument { name: name.into(), url: url.into() });
        self
    }

    /// Adds a same-origin ES module that registers custom field renderers.
    pub fn field_module(mut self, url: impl Into<String>) -> Self {
        self.0.field_modules.push(url.into());
        self
    }

    /// Registers a paired Arazzo and Sendproof expectations file under `/sendproof/journeys/`.
    /// `name` is the route stem without a file extension.
    pub fn journey_file(mut self, name: impl Into<String>, arazzo_json: impl Into<Vec<u8>>, expectations_json: impl Into<Vec<u8>>) -> Self {
        self.0.journeys.push(journeys::JourneyFile::new(name.into(), arazzo_json.into(), expectations_json.into()));
        self
    }

    /// Registers a code journey generator. For the typed builder, use `journeys::JourneyConfigExt::journey` (feature `journeys`).
    /// The generator receives the primary OpenAPI route and unavailable operations during startup.
    #[doc(hidden)]
    pub fn journey_code(
        mut self,
        name: String,
        generate: impl FnOnce(&str, &[UnavailableOperation]) -> Result<(serde_json::Value, serde_json::Value), String> + Send + Sync + 'static,
    ) -> Self {
        self.1.push((name, Box::new(generate)));
        self
    }

    /// Advertises a sign-in method. `url` is `None` for non-interactive handlers.
    pub fn auth_provider(mut self, label: impl Into<String>, kind: impl Into<String>, url: Option<&str>) -> Self {
        self.0.auth_providers.push(AuthProvider { label: label.into(), kind: kind.into(), url: url.map(str::to_owned) });
        self
    }

    /// Shows SQL parameter values (subject to redaction). Defaults to on only in `Development`.
    pub fn include_sql_parameter_values(mut self, include: bool) -> Self {
        self.0.include_sql_parameter_values = Some(include);
        self
    }

    /// How long observed-send traces are kept. Defaults to five minutes.
    pub fn trace_retention(mut self, retention: Duration) -> Self {
        self.0.trace_retention = retention;
        self
    }

    /// Declares an operation as safe to run in a rollback-only preview.
    ///
    /// `path` is the route template relative to the mount, in the framework's own syntax.
    pub fn preview_operation(mut self, method: &str, path: impl Into<String>) -> Self {
        self.0.operations.push(Operation { method: method.to_ascii_uppercase(), path: path.into() });
        self
    }

    /// Marks an operation `preview: false`: a Preview of it is refused before its handler runs, and
    /// the workbench shows `reason` beside the disabled button. The route itself is served normally.
    ///
    /// Nothing infers this mark: it only saves the user a round trip, because the write guard stops
    /// the Preview at run time either way.
    pub fn preview_unavailable(self, method: &str, path: impl Into<String>, reason: impl Into<String>) -> Self {
        self.preview_unavailable_for(method, path, reason, std::iter::empty::<&str>())
    }

    /// Like [`preview_unavailable`](Self::preview_unavailable), also naming the stores the operation
    /// writes (store ids such as `redis`), so the workbench can show their marks.
    pub fn preview_unavailable_for<I, S>(mut self, method: &str, path: impl Into<String>, reason: impl Into<String>, stores: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.0.unavailable.push(UnavailableOperation {
            method: method.to_ascii_uppercase(),
            path: path.into(),
            reason: reason.into(),
            stores: stores.into_iter().map(Into::into).collect(),
        });
        self
    }

    /// Registers a hooked data store: MongoDB, Redis or DynamoDB. Only hooked clients are covered.
    pub fn data_store(mut self, store: impl DataStore) -> Self {
        self.0.stores.push(Arc::new(store));
        self
    }

    /// Registers the single preview provider.
    pub fn provider(mut self, provider: impl PreviewProvider) -> Self {
        self.0.provider = Some(Arc::new(provider));
        self
    }

    /// Resolves the caller from request headers, for display and for owning observed-send traces.
    pub fn identity<F, Fut>(mut self, resolver: F) -> Self
    where
        F: Fn(Headers) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = Option<Identity>> + Send + 'static,
    {
        self.0.identity = Some(Arc::new(move |headers| Box::pin(resolver(headers))));
        self
    }

    /// Restricts the workbench, previews and observed sends to callers the policy admits.
    pub fn workbench_policy(mut self, policy: impl Fn(Option<&Identity>) -> bool + Send + Sync + 'static) -> Self {
        self.0.policy = Some(Arc::new(policy));
        self
    }

    /// Validates and builds the configuration.
    pub fn build(self) -> Result<Config, ConfigError> {
        let mut config = self.0;
        let base = &config.path_base;
        if !(base.is_empty() || (base.starts_with('/') && !base.ends_with('/') && is_local_url(base))) {
            return Err(ConfigError(format!("path base `{base}` must be empty or start with `/` and not end with `/`")));
        }
        let urls = std::iter::once(&config.open_api_url)
            .chain(config.documents.iter().map(|d| &d.url))
            .chain(config.field_modules.iter())
            .chain(config.auth_providers.iter().filter_map(|p| p.url.as_ref()));
        for url in urls {
            if !is_local_url(url) {
                return Err(ConfigError(format!("`{url}` must be an application-relative, same-origin path")));
            }
        }
        for journey in &mut config.journeys {
            journey.prepare(base)?;
        }
        for (index, journey) in config.journeys.iter().enumerate() {
            if config.journeys[..index].iter().any(|previous| previous.name() == journey.name()) {
                return Err(ConfigError(format!("journey `{}` is registered more than once", journey.name())));
            }
        }
        for operation in &config.unavailable {
            let known = |store: &String| {
                store.starts_with(|c: char| c.is_ascii_lowercase()) && store.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            };
            if operation.reason.trim().is_empty() || operation.reason.chars().count() > 512 {
                return Err(ConfigError(format!(
                    "the reason for {} {} must be a sentence of at most 512 characters",
                    operation.method, operation.path
                )));
            }
            if !operation.stores.iter().all(known) {
                return Err(ConfigError(format!("list the stores {} {} writes as ids such as `redis`", operation.method, operation.path)));
            }
            if !operation.path.starts_with('/')
                || config.operations.iter().any(|op| op.method == operation.method && op.path == operation.path)
            {
                return Err(ConfigError(format!(
                    "{} {} is both a preview operation and marked unavailable, or is not a path",
                    operation.method, operation.path
                )));
            }
        }
        let mut problems = Vec::new();
        for (name, generate) in self.1 {
            let result = if config.journeys.iter().any(|journey| journey.name() == name) {
                Err(ConfigError(format!("journey `{name}` is registered more than once")))
            } else {
                journeys::JourneyFile::generate(name, generate, &config.open_api_url, &config.unavailable, base).and_then(|journey| {
                    if let Some(id) =
                        journey.workflow_ids().iter().find(|id| config.journeys.iter().any(|other| other.workflow_ids().contains(id)))
                    {
                        return Err(ConfigError(format!("journey `{}`: workflow id `{id}` is already registered", journey.name())));
                    }
                    Ok(journey)
                })
            };
            match result {
                Ok(journey) => config.journeys.push(journey),
                Err(error) if config.environment.eq_ignore_ascii_case("Development") => problems.push(error.0),
                Err(error) => tracing::warn!("Skipped a journey: {error}"),
            }
        }
        if !problems.is_empty() {
            return Err(ConfigError(problems.join("\n")));
        }
        Ok(config)
    }
}

/// Whether `url` is an application-relative path that cannot leave the origin.
pub fn is_local_url(url: &str) -> bool {
    let path = url.split('?').next().unwrap_or("");
    let decoded = crate::protocol::percent_decode(path);
    path.starts_with('/')
        && !decoded.starts_with("//")
        && !decoded.split('/').any(|segment| segment == "." || segment == "..")
        && !url.contains('#')
        && !url.contains('\\')
        && !decoded.contains('\\')
        && !url.chars().any(|c| c.is_whitespace() || c.is_control())
        && !decoded.chars().any(char::is_control)
}

/// Whether `path` matches a route template: `{name}` matches one segment, `{*name}` the rest.
pub fn template_matches(template: &str, path: &str) -> bool {
    let mut route = template.split('/');
    let mut actual = path.split('/');
    loop {
        match (route.next(), actual.next()) {
            (None, None) => return true,
            (Some(pattern), Some(segment)) => {
                if pattern.starts_with("{*") && pattern.ends_with('}') {
                    return !segment.is_empty();
                }
                let parameter = pattern.starts_with('{') && pattern.ends_with('}');
                if parameter && !segment.is_empty() {
                    continue;
                }
                if pattern != segment {
                    return false;
                }
            }
            _ => return false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_route_templates() {
        assert!(template_matches("/items/{id}", "/items/12"));
        assert!(!template_matches("/items/{id}", "/items/12/fail"));
        assert!(!template_matches("/items/{id}", "/items/"));
        assert!(template_matches("/items/{id}/fail", "/items/a/fail"));
        assert!(template_matches("/files/{*rest}", "/files/a/b/c"));
        assert!(!template_matches("/items", "/items/12"));
    }

    #[test]
    fn accepts_only_local_urls() {
        assert!(is_local_url("/auth/sign-in"));
        for bad in ["//evil.test", "https://evil.test", "/a/../b", "/a\\b", "relative"] {
            assert!(!is_local_url(bad), "{bad}");
        }
    }

    #[test]
    fn rejects_a_trailing_slash_path_base() {
        assert!(Config::builder("x").path_base("/tenant/").build().is_err());
        assert!(Config::builder("x").path_base("/tenant").build().is_ok());
    }

    #[test]
    fn registers_paired_journey_documents_with_mount_aware_openapi_source() {
        let config = Config::builder("x")
            .path_base("/tenant")
            .open_api_url("/openapi.json")
            .journey_file(
                "sample",
                br#"{"arazzo":"1.1.0","info":{"title":"Sample","version":"1.0.0"},"sourceDescriptions":[{"name":"api","url":"/openapi.json","type":"openapi"},{"name":"other","url":"/catalog/openapi.json","type":"openapi"},{"name":"nested","url":"/catalog/reference.json","type":"arazzo"},{"name":"external","url":"https://schemas.example.test/openapi.json","type":"openapi"},{"name":"networkPath","url":"//cdn.example.test/openapi.json","type":"openapi"}],"workflows":[{"workflowId":"sample","steps":[{"stepId":"get","operationPath":"/items","parameters":[{"name":"id","in":"query","value":"x"}]}]}]}"#.to_vec(),
                br#"{"sendproofExpectations":"1.0","arazzo":"old-name","journeys":{}}"#.to_vec(),
            )
            .build()
            .unwrap();

        let arazzo: serde_json::Value = serde_json::from_slice(config.journey_document("/journeys/sample.arazzo.json").unwrap()).unwrap();
        let expectations: serde_json::Value =
            serde_json::from_slice(config.journey_document("/journeys/sample.expect.json").unwrap()).unwrap();
        assert_eq!(arazzo["sourceDescriptions"][0]["url"], "/tenant/openapi.json");
        assert_eq!(arazzo["sourceDescriptions"][1]["url"], "/tenant/catalog/openapi.json");
        assert_eq!(arazzo["sourceDescriptions"][2]["url"], "/tenant/catalog/reference.json");
        assert_eq!(arazzo["sourceDescriptions"][3]["url"], "https://schemas.example.test/openapi.json");
        assert_eq!(arazzo["sourceDescriptions"][4]["url"], "//cdn.example.test/openapi.json");
        assert_eq!(expectations["arazzo"], "sample.arazzo.json");
        assert!(config.journey_document("/journeys/unknown.arazzo.json").is_none());
        assert!(config.journey_document("/journeys/sample.js").is_none());
        assert!(config.journey_document("/journeys/sample.arazzo.json/extra").is_none());
    }

    #[test]
    fn rejects_duplicate_or_unsafe_journey_names() {
        let duplicate = Config::builder("x")
            .journey_file("sample", br#"{"sourceDescriptions":[{"type":"openapi"}]}"#.to_vec(), br#"{}"#.to_vec())
            .journey_file("sample", br#"{"sourceDescriptions":[{"type":"openapi"}]}"#.to_vec(), br#"{}"#.to_vec())
            .build();
        assert!(duplicate.is_err());
        let unsafe_name = Config::builder("x").journey_file("../secret", br#"{}"#.to_vec(), br#"{}"#.to_vec()).build();
        assert!(unsafe_name.is_err());
    }
}
