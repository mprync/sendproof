//! A framework-neutral copy of request or response headers.
//!
//! Adapters convert their framework's header map into [`Headers`], so the protocol rules do not
//! depend on the version of any HTTP crate. Names are stored in lower case and values that are not
//! valid UTF-8 are converted lossily.

/// Header names and values, in order, with lower-case names.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Headers(Vec<(String, String)>);

impl Headers {
    /// Creates an empty list.
    pub fn new() -> Self {
        Self::default()
    }

    /// Appends a header.
    pub fn push(&mut self, name: &str, value: &str) {
        self.0.push((name.to_ascii_lowercase(), value.to_owned()));
    }

    /// The first value of `name`, compared case-insensitively.
    pub fn get(&self, name: &str) -> Option<&str> {
        self.0.iter().find(|(candidate, _)| candidate.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
    }

    /// Every value of `name`, compared case-insensitively.
    pub fn get_all<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a str> + 'a {
        self.0.iter().filter(move |(candidate, _)| candidate.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
    }

    /// Iterates `(name, value)` pairs.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.0.iter().map(|(name, value)| (name.as_str(), value.as_str()))
    }

    /// The value of a cookie in the `Cookie` header, if present.
    pub fn cookie(&self, name: &str) -> Option<&str> {
        self.get_all("cookie")
            .flat_map(|line| line.split(';'))
            .filter_map(|pair| pair.trim().split_once('='))
            .find(|(candidate, _)| *candidate == name)
            .map(|(_, value)| value)
    }
}

impl FromIterator<(String, String)> for Headers {
    fn from_iter<I: IntoIterator<Item = (String, String)>>(iter: I) -> Self {
        Self(iter.into_iter().map(|(name, value)| (name.to_ascii_lowercase(), value)).collect())
    }
}

impl From<&http::HeaderMap> for Headers {
    fn from(map: &http::HeaderMap) -> Self {
        map.iter().map(|(name, value)| (name.as_str().to_owned(), String::from_utf8_lossy(value.as_bytes()).into_owned())).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_headers_and_cookies_case_insensitively() {
        let mut headers = Headers::new();
        headers.push("Cookie", "a=1; bench_session=abc");
        headers.push("Prefer", "trace");
        headers.push("prefer", "tx=rollback");
        assert_eq!(headers.get("COOKIE"), Some("a=1; bench_session=abc"));
        assert_eq!(headers.cookie("bench_session"), Some("abc"));
        assert_eq!(headers.cookie("missing"), None);
        assert_eq!(headers.get_all("Prefer").collect::<Vec<_>>(), ["trace", "tx=rollback"]);
    }
}
