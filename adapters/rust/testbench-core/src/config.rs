//! Configuration shared by every framework adapter.

use std::{fmt, sync::Arc, time::Duration};

use crate::{
    headers::Headers,
    provider::{BoxFuture, PreviewProvider},
    trace_store::DEFAULT_RETENTION,
};

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

/// Resolves the caller from the headers of a request.
pub type IdentityResolver = Arc<dyn Fn(Headers) -> BoxFuture<'static, Option<Identity>> + Send + Sync>;
/// Decides whether a caller may use the workbench, previews and observed sends.
pub type WorkbenchPolicy = Arc<dyn Fn(Option<&Identity>) -> bool + Send + Sync>;

/// An invalid configuration value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError(pub String);

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid Test Bench configuration: {}", self.0)
    }
}

impl std::error::Error for ConfigError {}

/// Framework-neutral configuration. Build it with [`Config::builder`].
///
/// Test Bench is **off by default**. It only serves the workbench and previews when
/// the configured [`environment`](ConfigBuilder::environment) is one of the
/// [`enable_in`](ConfigBuilder::enable_in) environments.
pub struct Config {
    pub(crate) api_name: String,
    pub(crate) environment: String,
    pub(crate) enabled_in: Vec<String>,
    pub(crate) open_api_url: String,
    pub(crate) documents: Vec<OpenApiDocument>,
    pub(crate) field_modules: Vec<String>,
    pub(crate) auth_providers: Vec<AuthProvider>,
    pub(crate) include_sql_parameter_values: Option<bool>,
    pub(crate) path_base: String,
    pub(crate) trace_retention: Duration,
    pub(crate) operations: Vec<Operation>,
    pub(crate) provider: Option<Arc<dyn PreviewProvider>>,
    pub(crate) identity: Option<IdentityResolver>,
    pub(crate) policy: Option<WorkbenchPolicy>,
}

impl Config {
    /// Starts a configuration for the API called `api_name`.
    pub fn builder(api_name: impl Into<String>) -> ConfigBuilder {
        ConfigBuilder(Config {
            api_name: api_name.into(),
            environment: "Production".into(),
            enabled_in: Vec::new(),
            open_api_url: "/openapi/v1.json".into(),
            documents: Vec::new(),
            field_modules: Vec::new(),
            auth_providers: Vec::new(),
            include_sql_parameter_values: None,
            path_base: String::new(),
            trace_retention: DEFAULT_RETENTION,
            operations: Vec::new(),
            provider: None,
            identity: None,
            policy: None,
        })
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
pub struct ConfigBuilder(Config);

impl ConfigBuilder {
    /// The environment label shown in the workbench, such as `Development`. Defaults to `Production`.
    pub fn environment(mut self, name: impl Into<String>) -> Self {
        self.0.environment = name.into();
        self
    }

    /// The environments in which Test Bench is enabled. Nothing is enabled by default.
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
        let config = self.0;
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
}
