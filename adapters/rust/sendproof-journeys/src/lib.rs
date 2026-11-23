//! Define Arazzo workflows and expected writes alongside the API that serves them.

mod documents;
mod expectations;

use schemars::{JsonSchema, generate::SchemaSettings};
use sendproof_core::ConfigBuilder;
use serde_json::{Map, Value, json};

pub use expectations::{ApprovedDifference, Match, WriteExpectation};

/// Registers a code journey alongside any file journeys on either framework adapter.
pub trait JourneyConfigExt {
    /// `name` is the document route stem. Pass the same OpenAPI document the app serves.
    fn journey(self, name: impl Into<String>, journey: Journey, open_api: Value) -> Self;
}

impl JourneyConfigExt for ConfigBuilder {
    fn journey(self, name: impl Into<String>, journey: Journey, open_api: Value) -> Self {
        let name = name.into();
        self.journey_code(name.clone(), move |url, unavailable| journey.documents(&name, &open_api, url, unavailable))
    }
}

/// One workflow and its Sendproof expectations.
pub struct Journey {
    id: String,
    name: String,
    summary: Option<String>,
    group: Option<String>,
    persona: Option<String>,
    send_only: Option<String>,
    defined_in: Option<Value>,
    inputs: Value,
    steps: Vec<Step>,
}

impl Journey {
    pub fn new(id: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            summary: None,
            group: None,
            persona: None,
            send_only: None,
            defined_in: None,
            inputs: json!({ "type": "object", "properties": {} }),
            steps: Vec::new(),
        }
    }

    /// Overrides the workflow summary, which defaults to the document name.
    pub fn summary(mut self, summary: impl Into<String>) -> Self {
        self.summary = Some(summary.into());
        self
    }

    pub fn group(mut self, group: impl Into<String>) -> Self {
        self.group = Some(group.into());
        self
    }

    pub fn run_as(mut self, persona: impl Into<String>) -> Self {
        self.persona = Some(persona.into());
        self
    }

    pub fn send_only(mut self, reason: impl Into<String>) -> Self {
        self.send_only = Some(reason.into());
        self
    }

    /// Records the defining Rust symbol and source file in the expectations document.
    pub fn defined_in(mut self, symbol: &str, file: &str) -> Self {
        self.defined_in = Some(json!({ "type": symbol, "file": file }));
        self
    }

    /// Derives the Arazzo inputs schema, including Serde names and defaults.
    pub fn inputs<T: JsonSchema>(mut self) -> Self {
        let schema = SchemaSettings::draft2020_12()
            .with(|settings| {
                settings.meta_schema = None;
                settings.inline_subschemas = true;
            })
            .into_generator()
            .into_root_schema_for::<T>();
        self.inputs = schema.to_value();
        if let Some(object) = self.inputs.as_object_mut() {
            object.remove("title");
        }
        self
    }

    pub fn step(mut self, step: Step) -> Self {
        self.steps.push(step);
        self
    }
}

/// A runtime value suitable for use as a parameter, in a JSON payload, or in expected writes.
pub struct Ref;

impl Ref {
    pub fn input(name: &str) -> Value {
        json!(format!("$inputs.{name}"))
    }

    pub fn output(step: &str, name: &str) -> Value {
        json!(format!("$steps.{step}.outputs.{name}"))
    }
}

/// The location of a bound OpenAPI parameter.
pub enum Parameter {
    Path,
    Query,
    Header,
}

/// One named OpenAPI operation and the assertions made after it returns.
pub struct Step {
    id: String,
    operation: String,
    parameters: Vec<Value>,
    body: Option<Value>,
    outputs: Vec<(String, String)>,
    criteria: Vec<String>,
    persona: Option<String>,
    writes: Option<Vec<WriteExpectation>>,
    effects: Option<Vec<Value>>,
}

impl Step {
    pub fn new(id: impl Into<String>, operation_id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            operation: operation_id.into(),
            parameters: Vec::new(),
            body: None,
            outputs: Vec::new(),
            criteria: Vec::new(),
            persona: None,
            writes: None,
            effects: None,
        }
    }

    pub fn parameter(mut self, location: Parameter, name: &str, value: impl Into<Value>) -> Self {
        let location = match location {
            Parameter::Path => "path",
            Parameter::Query => "query",
            Parameter::Header => "header",
        };
        self.parameters.push(json!({ "name": name, "in": location, "value": value.into() }));
        self
    }

    /// Binds an application/json payload. Runtime expressions can appear anywhere in the JSON.
    pub fn body(mut self, payload: impl Into<Value>) -> Self {
        self.body = Some(payload.into());
        self
    }

    /// Exposes a JSON Pointer into the response body as a named output. An empty pointer exposes the whole body.
    pub fn output(mut self, name: &str, pointer: &str) -> Self {
        self.outputs.push((name.into(), pointer.into()));
        self
    }

    pub fn succeeds_with(self, status: u16) -> Self {
        self.success_criterion(format!("$statusCode == {status}"))
    }

    pub fn success_criterion(mut self, condition: impl Into<String>) -> Self {
        self.criteria.push(condition.into());
        self
    }

    pub fn run_as(mut self, persona: impl Into<String>) -> Self {
        self.persona = Some(persona.into());
        self
    }

    /// Adds expected writes. An empty list declares that the step writes nothing.
    pub fn expect_writes(mut self, writes: impl IntoIterator<Item = WriteExpectation>) -> Self {
        self.writes.get_or_insert_with(Vec::new).extend(writes);
        self
    }

    /// Adds an expected effect, such as `email` with `to` and `subject` fields.
    pub fn expect_effect(mut self, kind: &str, fields: impl IntoIterator<Item = (impl Into<String>, Value)>) -> Self {
        let mut fields: Map<_, _> = fields.into_iter().map(|(name, value)| (name.into(), value)).collect();
        fields.insert("kind".into(), json!(kind));
        self.effects.get_or_insert_with(Vec::new).push(Value::Object(fields));
        self
    }

    /// Sets empty expectations for writes and effects, replacing any already declared.
    pub fn expect_nothing(mut self) -> Self {
        self.writes = Some(Vec::new());
        self.effects = Some(Vec::new());
        self
    }
}
