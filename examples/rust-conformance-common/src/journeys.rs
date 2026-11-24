use schemars::JsonSchema;
use sendproof_core::journeys::{Journey, Parameter, Ref, Step};

#[derive(JsonSchema)]
#[allow(dead_code)]
struct LookupInputs {
    #[schemars(default = "default_id")]
    id: String,
}

fn default_id() -> String {
    "conformance-item".into()
}

pub(crate) fn item_lookup() -> Journey {
    Journey::new("itemLookup", "Rust conformance journey")
        .summary("Look up an item")
        .defined_in("item_lookup", "src/journeys.rs")
        .inputs::<LookupInputs>()
        .step(
            Step::new("getItem", "getItem")
                .parameter(Parameter::Path, "id", Ref::input("id"))
                .succeeds_with(200),
        )
}

#[cfg(test)]
mod tests {
    use sendproof_core::{Config, protocol::capabilities};
    use sendproof_core::journeys::JourneyConfigExt;
    use serde_json::Value;

    use super::*;
    use crate::openapi;

    #[test]
    fn code_journey_matches_both_fixture_documents() {
        let config = Config::builder("Sendproof Conformance")
            .environment("Development")
            .journey("conformance", item_lookup(), openapi::document())
            .open_api_url("/openapi.json")
            .build()
            .unwrap();
        let caps = capabilities(&config, None, &[], "Axum");
        assert_eq!(caps["journeys"][0]["source"], "code");
        for (name, golden) in [
            (
                "conformance.arazzo.json",
                include_str!("../Journeys/conformance.arazzo.json"),
            ),
            (
                "conformance.expect.json",
                include_str!("../Journeys/conformance.expect.json"),
            ),
        ] {
            let served = config
                .journey_document(&format!("/journeys/{name}"))
                .unwrap();
            assert_eq!(
                serde_json::from_slice::<Value>(served).unwrap(),
                serde_json::from_str::<Value>(golden).unwrap()
            );
        }
    }
}
