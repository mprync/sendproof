use std::collections::{HashMap, HashSet};

use sendproof_core::UnavailableOperation;
use serde_json::{Map, Value, json};

use crate::Journey;

impl Journey {
    pub(super) fn documents(
        self,
        stem: &str,
        open_api: &Value,
        url: &str,
        unavailable: &[UnavailableOperation],
    ) -> Result<(Value, Value), String> {
        let mut problems = Vec::new();
        if self.id.trim().is_empty() || self.name.trim().is_empty() || self.steps.is_empty() {
            problems.push("a workflow needs an id, a name and at least one step".into());
        }
        if self.inputs["type"] != "object" {
            problems.push("journey inputs must be an object (derive JsonSchema on a named-field struct)".into());
        }
        if self.send_only.as_ref().is_some_and(|reason| reason.trim().is_empty()) {
            problems.push("a Send-only journey needs a reason".into());
        }
        let operations = operations(open_api);
        let mut send_only = self.send_only;
        let mut prior = HashMap::new();
        let mut approved_ids = HashSet::new();
        let mut steps = Vec::new();
        let mut expected_steps = Map::new();
        let mut approved = Vec::new();

        for step in &self.steps {
            let mut report = |message: String| problems.push(format!("step `{}`: {message}", step.id));
            if step.id.trim().is_empty() || prior.contains_key(step.id.as_str()) {
                report("step ids must be unique and nonempty".into());
            }
            match operations.get(step.operation.as_str()).map(Vec::as_slice) {
                Some([(method, path)]) => {
                    if let Some(mark) = unavailable.iter().find(|mark| mark.method.eq_ignore_ascii_case(method) && mark.path == *path) {
                        send_only.get_or_insert_with(|| format!("Step {} is Send only: {}", step.id, mark.reason));
                    }
                }
                Some(_) => {
                    report(format!("OpenAPI operationId `{}` is ambiguous", step.operation));
                }
                None => report(format!("unknown OpenAPI operationId `{}`", step.operation)),
            }

            let mut output = json!({ "stepId": step.id, "operationId": step.operation });
            if !step.parameters.is_empty() {
                output["parameters"] = json!(step.parameters);
                for parameter in &step.parameters {
                    check_value(&parameter["value"], &self.inputs, &prior, &mut report);
                }
            }
            if let Some(body) = &step.body {
                check_value(body, &self.inputs, &prior, &mut report);
                output["requestBody"] = json!({ "contentType": "application/json", "payload": body });
            }
            if !step.criteria.is_empty() {
                output["successCriteria"] =
                    json!(step.criteria.iter().map(|condition| json!({ "condition": condition })).collect::<Vec<_>>());
            }
            let mut outputs = HashSet::new();
            let mut expressions = Map::new();
            for (name, pointer) in &step.outputs {
                if name.trim().is_empty() || !outputs.insert(name.as_str()) {
                    report(format!("output name `{name}` must be unique and nonempty"));
                }
                if pointer.is_empty() {
                    expressions.insert(name.clone(), json!("$response.body"));
                } else {
                    if !pointer.starts_with('/') {
                        report(format!("output `{name}` needs a JSON Pointer into the response body"));
                    }
                    expressions.insert(name.clone(), json!(format!("$response.body#{pointer}")));
                }
            }
            if !expressions.is_empty() {
                output["outputs"] = Value::Object(expressions);
            }
            steps.push(output);
            // Writes can use the current step's outputs. Request bindings above can only use earlier ones.
            prior.insert(step.id.as_str(), outputs);

            let mut expected = Map::new();
            if let Some(persona) = &step.persona {
                expected.insert("persona".into(), json!(persona));
            }
            if step.writes.is_some() || step.effects.is_some() {
                let mut writes = Vec::new();
                for write in step.writes.iter().flatten() {
                    let document = &write.document;
                    check_value(document, &self.inputs, &prior, &mut report);
                    let store = document["store"].as_str().unwrap_or_default();
                    if matches!(store, "redis" | "dynamodb" | "cassandra" | "elasticsearch" | "opensearch") {
                        send_only.get_or_insert_with(|| format!("Step {} writes to {store}, which can't roll back.", step.id));
                    }
                    if store == "redis" && !document["key"].is_string() {
                        report("a Redis write needs a string key or key expression".into());
                    }
                    for (field, difference) in &write.approvals {
                        let target = document.get("table").or_else(|| document.get("collection"));
                        let expected = document["values"].get(field);
                        let (Some(target), Some(expected)) = (target, expected) else {
                            report(format!("approved difference `{}` needs a declared table or collection field `{field}`", difference.id));
                            continue;
                        };
                        if [&difference.id, &difference.reason, &difference.approved_by].iter().any(|value| value.trim().is_empty()) {
                            report("an approved difference needs an id, a reason and an approver".into());
                        }
                        if !approved_ids.insert(difference.id.as_str()) {
                            report(format!("approved difference `{}` is used more than once", difference.id));
                        }
                        let mut record = json!({
                            "id": difference.id, "journey": self.id, "step": step.id,
                            "target": { "store": store, "table": target, "field": field }, "kind": "value",
                            "expected": expected, "actual": difference.actual, "reason": difference.reason,
                            "approvedBy": difference.approved_by, "approvedOn": difference.approved_on.to_string(),
                        });
                        if let Some(expires) = &difference.expires {
                            record["expires"] = json!(expires.to_string());
                        }
                        if let Some(link) = &difference.link {
                            record["link"] = json!(link);
                        }
                        approved.push(record);
                    }
                    writes.push(document);
                }
                expected.insert("writes".into(), json!(writes));
                if let Some(effects) = &step.effects {
                    for effect in effects {
                        check_value(effect, &self.inputs, &prior, &mut report);
                    }
                    expected.insert("effects".into(), json!(effects));
                }
                expected.insert("unlisted".into(), json!("fail"));
            }
            if !expected.is_empty() {
                expected_steps.insert(step.id.clone(), Value::Object(expected));
            }
        }
        if !problems.is_empty() {
            return Err(format!("workflow `{}`: {}", self.id, problems.join("\n")));
        }

        let mut entry = json!({ "steps": expected_steps });
        if let Some(group) = self.group {
            entry["group"] = json!(group);
        }
        if let Some(persona) = self.persona {
            entry["runAs"] = json!(persona);
        }
        if let Some(defined_in) = self.defined_in {
            entry["definedIn"] = defined_in;
        }
        if let Some(reason) = send_only {
            entry["sendOnly"] = json!(true);
            entry["sendOnlyReason"] = json!(reason);
        }
        Ok((
            json!({
                "arazzo": "1.1.0",
                "info": { "title": self.name, "version": "1.0.0" },
                "sourceDescriptions": [{ "name": source_name(&open_api["info"]["title"]), "url": url, "type": "openapi" }],
                "workflows": [{
                    "workflowId": self.id,
                    "summary": self.summary.as_ref().unwrap_or(&self.name),
                    "inputs": self.inputs,
                    "steps": steps,
                }],
            }),
            json!({
                "sendproofExpectations": "1.0",
                "arazzo": format!("{stem}.arazzo.json"),
                "journeys": { self.id: entry },
                "approvedDifferences": approved,
            }),
        ))
    }
}

fn operations(open_api: &Value) -> HashMap<&str, Vec<(&str, &str)>> {
    const METHODS: [&str; 9] = ["get", "put", "post", "delete", "options", "head", "patch", "trace", "query"];
    let mut operations = HashMap::<_, Vec<_>>::new();
    for (path, item) in open_api["paths"].as_object().into_iter().flatten() {
        let item = item["$ref"]
            .as_str()
            .and_then(|reference| reference.strip_prefix('#'))
            .and_then(|pointer| open_api.pointer(pointer))
            .unwrap_or(item);
        for method in METHODS {
            if let Some(id) = item[method]["operationId"].as_str().filter(|id| !id.is_empty()) {
                operations.entry(id).or_default().push((method, path.as_str()));
            }
        }
    }
    operations
}

fn source_name(title: &Value) -> String {
    let mut name = String::new();
    for word in title.as_str().unwrap_or_default().split(|c: char| !c.is_ascii_alphanumeric()).filter(|word| !word.is_empty()) {
        let mut chars = word.chars();
        let first = chars.next().unwrap();
        name.push(if name.is_empty() { first.to_ascii_lowercase() } else { first.to_ascii_uppercase() });
        name.extend(chars);
    }
    if name.is_empty() { "api".into() } else { name }
}

fn check_value(value: &Value, inputs: &Value, prior: &HashMap<&str, HashSet<&str>>, report: &mut impl FnMut(String)) {
    match value {
        Value::Array(values) => values.iter().for_each(|value| check_value(value, inputs, prior, report)),
        Value::Object(fields) => fields.values().for_each(|value| check_value(value, inputs, prior, report)),
        Value::String(value) => {
            let templates = value.split('{').skip(1).filter_map(|part| part.split_once('}').map(|(expression, _)| expression));
            for expression in std::iter::once(value.as_str()).chain(templates) {
                if let Some(name) = expression.strip_prefix("$inputs.") {
                    if !input_exists(inputs, inputs, &name.split('.').collect::<Vec<_>>()) {
                        report(format!("unknown input `{name}`"));
                    }
                } else if let Some(reference) = expression.strip_prefix("$steps.") {
                    let exists = reference.split_once(".outputs.").is_some_and(|(step, output)| {
                        prior.get(step).is_some_and(|outputs| outputs.contains(output.split('.').next().unwrap_or_default()))
                    });
                    if !exists {
                        report(format!("invalid output reference `{expression}`; use a declared output available at this point"));
                    }
                }
            }
        }
        _ => {}
    }
}

// This checks the names in a binding, not the input instance against its schema.
fn input_exists(root: &Value, schema: &Value, path: &[&str]) -> bool {
    let Some((name, rest)) = path.split_first() else { return true };
    if name.is_empty() {
        return false;
    }
    let schema = schema["$ref"]
        .as_str()
        .and_then(|reference| reference.strip_prefix('#'))
        .and_then(|pointer| root.pointer(pointer))
        .unwrap_or(schema);
    if schema == true {
        return true;
    }
    let child = schema["properties"]
        .get(*name)
        .or_else(|| name.parse::<usize>().ok().and_then(|index| schema["prefixItems"].get(index).or_else(|| schema.get("items"))))
        .or_else(|| schema.get("additionalProperties").filter(|value| **value != false));
    child.is_some_and(|child| input_exists(root, child, rest))
        || ["anyOf", "oneOf", "allOf"]
            .iter()
            .any(|key| schema[key].as_array().is_some_and(|schemas| schemas.iter().any(|variant| input_exists(root, variant, path))))
}

#[cfg(test)]
mod tests;
