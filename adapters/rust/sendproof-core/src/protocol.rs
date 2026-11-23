//! Framework-neutral protocol rules: preferences, origin checks, targets, discovery and envelopes.

use std::collections::BTreeMap;

use serde_json::{Value, json};

use crate::{
    capture::Blocked,
    config::{Config, Identity},
    headers::Headers,
    limits,
    model::{Change, Effect, LogEntry, PreviewEnvelope},
    stores::StoreDescription,
};

/// The reserved path prefix of previews, relative to the mount.
pub const PREVIEW_PREFIX: &str = "/sendproof/_preview";
/// The workbench path prefix, relative to the mount.
pub const WORKBENCH_PREFIX: &str = "/sendproof";
/// The response header carrying an observed-send trace identifier.
pub const TRACE_HEADER: &str = "x-sendproof-trace";
/// The request header selecting a held Preview session.
pub const SESSION_HEADER: &str = "sendproof-session";
pub(crate) const SESSIONS_PATH: &str = "/sendproof/_api/sessions";
/// The value of the rollback preference.
pub const ROLLBACK_PREFERENCE: &str = "tx=rollback";

const PRIVATE_HEADERS: &[&str] = &["set-cookie", "location", "content-length", "transfer-encoding", "connection", "upgrade", "trailer"];

/// Whether any `Prefer` value requests `tx=rollback`.
pub fn requests_rollback(headers: &Headers) -> bool {
    headers.get_all("prefer").any(|value| {
        value.split([',', ';']).any(|part| {
            part.split_once('=').is_some_and(|(name, value)| {
                name.trim().eq_ignore_ascii_case("tx") && value.trim().trim_matches('"').eq_ignore_ascii_case("rollback")
            })
        })
    })
}

/// Whether there is exactly one `Prefer` header and it is exactly `tx=rollback`.
pub fn has_exact_preference(headers: &Headers) -> bool {
    let mut values = headers.get_all("prefer");
    match (values.next(), values.next()) {
        (Some(value), None) => value.trim().eq_ignore_ascii_case(ROLLBACK_PREFERENCE),
        _ => false,
    }
}

/// Whether any `Prefer` token is `trace`.
pub fn requests_trace(headers: &Headers) -> bool {
    headers
        .get_all("prefer")
        .flat_map(|value| value.split(','))
        .any(|token| token.split(';').next().is_some_and(|name| name.trim().eq_ignore_ascii_case("trace")))
}

/// Whether the request is same-origin: no `Sec-Fetch-Site: cross-site`, and no `Origin`
/// other than the request's own authority.
///
/// The scheme is not compared, because applications commonly sit behind a TLS terminator.
pub fn is_same_origin(headers: &Headers) -> bool {
    if headers.get("sec-fetch-site").is_some_and(|value| value.eq_ignore_ascii_case("cross-site")) {
        return false;
    }
    let mut origins = headers.get_all("origin");
    let Some(origin) = origins.next() else { return true };
    if origins.next().is_some() {
        return false;
    }
    let Some((scheme, rest)) = origin.split_once("://") else { return false };
    let authority = rest.trim_end_matches('/');
    if authority.contains(['/', '?', '#', '@']) {
        return false;
    }
    let Some(host) = headers.get("host") else { return false };
    normalize_authority(authority, scheme) == normalize_authority(host, scheme)
}

fn normalize_authority(authority: &str, scheme: &str) -> String {
    let default = if scheme.eq_ignore_ascii_case("https") { "443" } else { "80" };
    let lower = authority.to_ascii_lowercase();
    match lower.rsplit_once(':') {
        Some((host, port)) if !port.contains(']') && port == default => host.to_owned(),
        _ => lower,
    }
}

/// Whether a preview target (the path after `/sendproof/_preview`) is acceptable.
pub fn is_valid_target(target: &str) -> bool {
    if target.is_empty() || target.starts_with("//") {
        return false;
    }
    let decoded = percent_decode(target);
    // A target inside the workbench (in any case or encoding) would nest a preview.
    let lower = decoded.to_ascii_lowercase();
    if lower == WORKBENCH_PREFIX || lower.starts_with("/sendproof/") {
        return false;
    }
    !decoded.starts_with("//")
        && !decoded.contains('\\')
        && !decoded.chars().any(char::is_control)
        && !decoded.split('/').any(|segment| segment == "." || segment == "..")
}

/// Decodes `%XX` escapes. Invalid escapes are kept literally.
pub fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let (Some(high), Some(low)) = (hex(bytes[index + 1]), hex(bytes[index + 2]))
        {
            out.push(high << 4 | low);
            index += 3;
            continue;
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex(byte: u8) -> Option<u8> {
    (byte as char).to_digit(16).map(|d| d as u8)
}

/// Prefixes an application-relative URL with the mount.
pub fn with_path_base(base: &str, url: &str) -> String {
    format!("{base}{url}")
}

/// Normalizes a framework route template to an OpenAPI path template (`{*rest}` becomes `{rest}`).
pub fn openapi_path(template: &str) -> String {
    template.replace("{*", "{")
}

/// Builds the capabilities document for the current request.
///
/// `stores` are the registered data stores, already described (see [`Config::describe_stores`]);
/// `framework` names the web framework of the adapter, such as `Axum`, for the workbench's
/// `preview: false` snippet.
pub fn capabilities(config: &Config, identity: Option<&Identity>, stores: &[StoreDescription], framework: &str) -> Value {
    let base = config.path_base();
    let provider = config.available_provider();
    let open_api_url = with_path_base(base, &config.open_api_url);
    let mut documents: Vec<Value> =
        config.documents.iter().map(|d| json!({ "name": d.name, "url": with_path_base(base, &d.url) })).collect();
    if !documents.iter().any(|d| d["url"] == open_api_url) {
        documents.insert(0, json!({ "name": config.api_name(), "url": open_api_url }));
    }
    let mut operations: Vec<(String, String)> = if config.can_preview() {
        config.operations.iter().filter(|op| op.method != "HEAD").map(|op| (openapi_path(&op.path), op.method.clone())).collect()
    } else {
        Vec::new()
    };
    operations.sort();
    operations.dedup();
    let preview_operations: Vec<Value> = operations.iter().map(|(path, method)| json!({ "method": method, "path": path })).collect();
    let auth: Vec<Value> = config
        .auth_providers
        .iter()
        .map(|p| json!({ "label": p.label, "kind": p.kind, "url": p.url.as_ref().map(|u| with_path_base(base, u)) }))
        .collect();
    let identity = identity.map(|identity| {
        let mut value = json!({ "name": identity.name });
        if let Some(role) = &identity.role {
            value["role"] = json!(role);
        }
        value
    });
    let database = provider.and_then(|provider| {
        let (name, system) = (provider.database(), provider.system());
        (name.is_some() || system.is_some()).then(|| {
            let mut value = json!({ "name": name });
            if let Some(system) = system {
                value["system"] = json!(system);
            }
            value
        })
    });
    let mut document = json!({
        "protocolVersion": 1,
        "openApiUrl": open_api_url,
        "fieldModules": config.field_modules.iter().map(|u| with_path_base(base, u)).collect::<Vec<_>>(),
        "apiName": config.api_name(),
        "environment": config.environment,
        "database": database,
        "identity": identity,
        "authProviders": auth,
        "previewOperations": preview_operations,
        "previewSessions": config.can_hold_preview(stores),
        "observedSend": !operations.is_empty(),
        "documents": documents,
    });
    if !framework.is_empty() {
        document["binding"] = json!({ "language": "rust", "framework": framework });
    }
    if !config.journeys.is_empty() {
        document["journeys"] = Value::Array(
            config
                .journeys
                .iter()
                .map(|journey| {
                    let stem = journey.name();
                    json!({
                        "name": journey.display_name(),
                        "source": "file",
                        "arazzoUrl": with_path_base(base, &format!("/sendproof/journeys/{stem}.arazzo.json")),
                        "expectationsUrl": with_path_base(base, &format!("/sendproof/journeys/{stem}.expect.json")),
                    })
                })
                .collect::<Vec<_>>(),
        );
    }
    if !stores.is_empty() {
        document["dataStores"] = stores
            .iter()
            .map(|store| {
                let mut entry = json!({ "system": store.system, "mode": store.mode.as_str() });
                if let Some(name) = &store.name {
                    entry["name"] = json!(name);
                }
                if let Some(reason) = &store.reason {
                    entry["reason"] = json!(reason);
                }
                entry
            })
            .collect();
    }
    if config.can_preview() && !config.unavailable.is_empty() {
        let mut unavailable: Vec<_> = config.unavailable.iter().collect();
        unavailable.sort_by(|a, b| (&a.path, &a.method).cmp(&(&b.path, &b.method)));
        document["previewUnavailable"] = unavailable
            .into_iter()
            .map(|op| {
                let mut entry = json!({ "method": op.method, "path": openapi_path(&op.path), "reason": op.reason });
                if !op.stores.is_empty() {
                    entry["stores"] = json!(op.stores);
                }
                entry
            })
            .collect();
    }
    document
}

/// The body of the blocked-Preview response (`spec/data-stores.md`): a problem document that names
/// the refused command, never its arguments, and says nothing was previewed.
pub fn blocked_body(blocked: &Blocked) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "type": "about:blank",
        "title": "Preview unavailable",
        "status": 409,
        "code": "preview_unavailable",
        "detail": blocked.detail,
        "store": blocked.store,
        "operation": blocked.operation,
        "rolledBack": false,
    }))
    .unwrap_or_default()
}

/// A problem-details body: `(status, JSON bytes)`.
pub fn problem(status: u16, title: &str) -> (u16, Vec<u8>) {
    let kind = match status {
        400 => "https://tools.ietf.org/html/rfc9110#section-15.5.1",
        401 => "https://tools.ietf.org/html/rfc9110#section-15.5.2",
        403 => "https://tools.ietf.org/html/rfc9110#section-15.5.4",
        404 => "https://tools.ietf.org/html/rfc9110#section-15.5.5",
        405 => "https://tools.ietf.org/html/rfc9110#section-15.5.6",
        409 => "https://tools.ietf.org/html/rfc9110#section-15.5.10",
        413 => "https://tools.ietf.org/html/rfc9110#section-15.5.14",
        500 => "https://tools.ietf.org/html/rfc9110#section-15.6.1",
        503 => "https://tools.ietf.org/html/rfc9110#section-15.6.4",
        _ => "about:blank",
    };
    (status, serde_json::to_vec(&json!({ "type": kind, "title": title, "status": status })).unwrap_or_default())
}

/// Maps the status of an unexecuted preview to the outer rejection `(status, title)`.
///
/// A preview whose handler never ran never yields an envelope. Authorization, routing
/// and provider failures are reported as the corresponding error.
pub fn reject_unexecuted(inner_status: u16) -> (u16, &'static str) {
    let title = match inner_status {
        401 => "Authentication is required for this preview.",
        403 => "This preview is forbidden.",
        404 | 405 => "The preview target was not found for this method.",
        503 => "Preview requires one available preview provider.",
        300..=399 => "Preview redirects are disabled. Sign in through the workbench first.",
        400..=499 if inner_status != 409 => "The host rejected the preview request.",
        _ => "This operation is unavailable for preview.",
    };
    let status = if !(400..500).contains(&inner_status) && inner_status != 503 {
        if (300..400).contains(&inner_status) { 401 } else { 409 }
    } else {
        inner_status
    };
    (status, title)
}

/// Reads a buffered response body as JSON, text, or base64.
pub fn read_body(content_type: Option<&str>, bytes: &[u8]) -> Value {
    if bytes.is_empty() {
        return Value::Null;
    }
    let media = content_type.unwrap_or("").split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    if media == "application/json" || media.ends_with("+json") {
        return serde_json::from_slice(bytes).unwrap_or_else(|_| Value::String(String::from_utf8_lossy(bytes).into_owned()));
    }
    if media.is_empty() || media.starts_with("text/") {
        Value::String(String::from_utf8_lossy(bytes).into_owned())
    } else {
        Value::String(base64(bytes))
    }
}

/// Builds the confirmed envelope from the captured inner response.
#[allow(clippy::too_many_arguments)]
pub fn build_envelope(
    status: u16,
    headers: &Headers,
    body: &[u8],
    changes: (Vec<Change>, bool),
    effects: Vec<Effect>,
    logs: Vec<LogEntry>,
    effects_truncated: bool,
    logs_truncated: bool,
) -> PreviewEnvelope {
    let mut visible: BTreeMap<String, String> = BTreeMap::new();
    for (name, value) in headers.iter() {
        let name = name.to_ascii_lowercase();
        if PRIVATE_HEADERS.contains(&name.as_str()) || name.len() > limits::NAME {
            continue;
        }
        if visible.len() == limits::PARAMETERS && !visible.contains_key(&name) {
            continue;
        }
        visible
            .entry(name)
            .and_modify(|existing| {
                existing.push_str(", ");
                existing.push_str(value);
            })
            .or_insert_with(|| value.to_owned());
    }
    let visible = visible.into_iter().map(|(name, value)| (name, limits::clip(&value, limits::TEXT))).collect();
    let content_type = headers.get("content-type");
    PreviewEnvelope {
        status,
        headers: visible,
        body: read_body(content_type, body),
        changes: changes.0,
        effects,
        logs,
        rolled_back: true,
        session: None,
        changes_truncated: changes.1,
        effects_truncated,
        logs_truncated,
    }
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&'static str, &'static str)]) -> Headers {
        let mut map = Headers::new();
        for (name, value) in pairs {
            map.push(name, value);
        }
        map
    }

    #[test]
    fn parses_preferences() {
        assert!(requests_rollback(&headers(&[("prefer", "return=minimal, tx=rollback")])));
        assert!(!requests_rollback(&headers(&[("prefer", "tx=commit")])));
        assert!(has_exact_preference(&headers(&[("prefer", "tx=rollback")])));
        assert!(!has_exact_preference(&headers(&[("prefer", "tx=rollback, trace")])));
        assert!(!has_exact_preference(&headers(&[("prefer", "tx=rollback"), ("prefer", "tx=rollback")])));
        assert!(requests_trace(&headers(&[("prefer", "trace")])));
        assert!(requests_trace(&headers(&[("prefer", "wait=5, Trace;x=1")])));
    }

    #[test]
    fn checks_origin() {
        assert!(is_same_origin(&headers(&[("host", "localhost:8080")])));
        assert!(is_same_origin(&headers(&[("host", "localhost:8080"), ("origin", "http://localhost:8080")])));
        assert!(!is_same_origin(&headers(&[("host", "localhost:8080"), ("origin", "http://evil.test")])));
        assert!(!is_same_origin(&headers(&[("host", "localhost:8080"), ("sec-fetch-site", "cross-site")])));
        assert!(!is_same_origin(&headers(&[("host", "localhost:8080"), ("origin", "http://localhost:8080/x")])));
    }

    #[test]
    fn validates_targets() {
        assert!(is_valid_target("/items/12"));
        for bad in [
            "",
            "//evil",
            "/sendproof/x",
            "/SENDPROOF/_preview/x",
            "/%73endproof/x",
            "/Sendproof",
            "/%2e%2e/x",
            "/a/../b",
            "/a%5Cb",
            "/%2F/x",
        ] {
            assert!(!is_valid_target(bad), "{bad:?} must be rejected");
        }
    }

    #[test]
    fn maps_unexecuted_previews() {
        assert_eq!(reject_unexecuted(401).0, 401);
        assert_eq!(reject_unexecuted(302).0, 401);
        assert_eq!(reject_unexecuted(200).0, 409);
        assert_eq!(reject_unexecuted(500).0, 409);
        assert_eq!(reject_unexecuted(503).0, 503);
    }

    #[test]
    fn reads_bodies() {
        assert_eq!(read_body(Some("application/json"), br#"{"a":1}"#), json!({"a": 1}));
        assert_eq!(read_body(Some("text/plain"), b"hi"), json!("hi"));
        assert_eq!(read_body(Some("application/octet-stream"), b"abc"), json!("YWJj"));
        assert_eq!(read_body(None, b""), Value::Null);
    }

    #[test]
    fn advertises_registered_journey_files_under_the_mount() {
        let config = Config::builder("x")
            .path_base("/tenant")
            .journey_file(
                "sample",
                br#"{"info":{"title":"Friendly sample","version":"1.0.0"},"sourceDescriptions":[{"name":"api","url":"/openapi.json","type":"openapi"}]}"#.to_vec(),
                br#"{"sendproofExpectations":"1.0","journeys":{}}"#.to_vec(),
            )
            .journey_file(
                "fallback-name",
                br#"{"sourceDescriptions":[{"name":"api","url":"/openapi.json","type":"openapi"}]}"#.to_vec(),
                br#"{"sendproofExpectations":"1.0","journeys":{}}"#.to_vec(),
            )
            .build()
            .unwrap();
        let capabilities = capabilities(&config, None, &[], "Axum");
        assert_eq!(capabilities["journeys"][0]["name"], "Friendly sample");
        assert_eq!(capabilities["journeys"][1]["name"], "fallback-name");
        assert_eq!(capabilities["journeys"][0]["source"], "file");
        assert_eq!(capabilities["journeys"][0]["arazzoUrl"], "/tenant/sendproof/journeys/sample.arazzo.json");
        assert_eq!(capabilities["journeys"][0]["expectationsUrl"], "/tenant/sendproof/journeys/sample.expect.json");
    }
}
