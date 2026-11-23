use serde_json::Value;

use super::{ConfigError, UnavailableOperation};

pub(super) type GenerateJourney = Box<dyn FnOnce(&str, &[UnavailableOperation]) -> Result<(Value, Value), String> + Send + Sync>;

/// One registered pair of journey documents. The URLs in each document are normalized during build.
#[derive(Debug, Clone)]
pub(crate) struct JourneyFile {
    name: String,
    display_name: String,
    source: &'static str,
    workflow_ids: Vec<String>,
    arazzo: Vec<u8>,
    expectations: Vec<u8>,
}

impl JourneyFile {
    pub(super) fn new(name: String, arazzo: Vec<u8>, expectations: Vec<u8>) -> Self {
        Self { display_name: name.clone(), name, source: "file", workflow_ids: Vec::new(), arazzo, expectations }
    }

    pub(super) fn generate(
        name: String,
        generate: GenerateJourney,
        open_api_url: &str,
        unavailable: &[UnavailableOperation],
        path_base: &str,
    ) -> Result<Self, ConfigError> {
        let (arazzo, expectations) =
            generate(open_api_url, unavailable).map_err(|error| ConfigError(format!("journey `{name}`: {error}")))?;
        let mut documents = Self::new(name, Vec::new(), Vec::new());
        documents.source = "code";
        documents.prepare_documents(arazzo, expectations, path_base)?;
        Ok(documents)
    }

    pub(super) fn prepare(&mut self, path_base: &str) -> Result<(), ConfigError> {
        let arazzo = serde_json::from_slice(&self.arazzo)
            .map_err(|error| ConfigError(format!("journey `{}` has invalid Arazzo JSON: {error}", self.name)))?;
        let expectations = serde_json::from_slice(&self.expectations)
            .map_err(|error| ConfigError(format!("journey `{}` has invalid expectations JSON: {error}", self.name)))?;
        self.prepare_documents(arazzo, expectations, path_base)
    }

    fn prepare_documents(&mut self, mut arazzo: Value, mut expectations: Value, path_base: &str) -> Result<(), ConfigError> {
        if self.name.is_empty()
            || self.name == "."
            || self.name == ".."
            || !self.name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~'))
        {
            return Err(ConfigError(format!("journey name `{}` must be a simple route name", self.name)));
        }

        let sources = arazzo
            .get_mut("sourceDescriptions")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| ConfigError(format!("journey `{}` must have Arazzo sourceDescriptions", self.name)))?;
        let mut has_open_api = false;
        for source in sources {
            let is_open_api = source.get("type").and_then(Value::as_str) == Some("openapi");
            if is_open_api {
                has_open_api = true;
            }
            let url = source.get("url").and_then(Value::as_str).map(str::to_owned);
            if is_open_api && url.is_none() {
                return Err(ConfigError(format!("journey `{}` has an OpenAPI source without a URL", self.name)));
            }
            if let Some(url) = url
                && !path_base.is_empty()
                && url.starts_with('/')
                && !url.starts_with("//")
            {
                source["url"] = Value::String(format!("{path_base}{url}"));
            }
        }
        if !has_open_api {
            return Err(ConfigError(format!("journey `{}` must reference an OpenAPI source", self.name)));
        }
        self.display_name = arazzo
            .get("info")
            .and_then(|info| info.get("title"))
            .and_then(Value::as_str)
            .filter(|title| !title.trim().is_empty())
            .unwrap_or(&self.name)
            .to_owned();
        self.workflow_ids = arazzo["workflows"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|workflow| workflow["workflowId"].as_str().map(str::to_owned))
            .collect();

        if !expectations.is_object() {
            return Err(ConfigError(format!("journey `{}` expectations must be a JSON object", self.name)));
        }
        expectations["arazzo"] = Value::String(format!("{}.arazzo.json", self.name));

        self.arazzo = serde_json::to_vec(&arazzo).map_err(|error| ConfigError(error.to_string()))?;
        self.expectations = serde_json::to_vec(&expectations).map_err(|error| ConfigError(error.to_string()))?;
        Ok(())
    }

    pub(crate) fn name(&self) -> &str {
        &self.name
    }

    pub(crate) fn display_name(&self) -> &str {
        &self.display_name
    }

    pub(crate) fn source(&self) -> &'static str {
        self.source
    }

    pub(super) fn workflow_ids(&self) -> &[String] {
        &self.workflow_ids
    }

    pub(crate) fn arazzo(&self) -> &[u8] {
        &self.arazzo
    }

    pub(crate) fn expectations(&self) -> &[u8] {
        &self.expectations
    }
}
