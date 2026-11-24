use schemars::JsonSchema;
use crate::{Config, protocol::capabilities};
use serde_json::{Value, json};
use time::{Date, Month};

use crate::journeys::{ApprovedDifference, Journey, JourneyConfigExt, Match, Parameter, Ref, Step, WriteExpectation};

#[derive(JsonSchema)]
#[allow(dead_code)]
struct Inputs {
    /// Email address for the receipt.
    email: String,
}

fn open_api() -> Value {
    json!({
        "openapi": "3.1.0", "info": { "title": "Store API" },
        "paths": { "/items": { "post": { "operationId": "putItem" } }, "/items/{id}": { "get": { "operationId": "readItem" } } }
    })
}

#[test]
fn generates_requests_assertions_and_expectations() {
    let item_id = Ref::output("put", "itemId");
    let email = Ref::input("email");
    let journey = Journey::new("receipt", "Send a receipt")
        .group("Sales")
        .run_as("admin@example.test")
        .inputs::<Inputs>()
        .step(
            Step::new("put", "putItem")
                .body(json!({ "buyer": { "email": email } }))
                .succeeds_with(201)
                .output("itemId", "/id")
                .expect_writes([
                    WriteExpectation::table("sqlite", "items", "update")
                        .row_key([("id", item_id.clone())])
                        .field("status", Match::changed("pending", "ready"))
                        .field("updated", Match::any("date-time"))
                        .field("category", "book")
                        .approve(
                            "category",
                            ApprovedDifference {
                                id: "AD-1".into(),
                                actual: json!("textbook"),
                                reason: "Renamed in the next release".into(),
                                approved_by: "reviewer@example.test".into(),
                                approved_on: Date::from_calendar_date(2026, Month::November, 23).unwrap(),
                                expires: Some(Date::from_calendar_date(2027, Month::January, 1).unwrap()),
                                link: None,
                            },
                        ),
                    WriteExpectation::mongo("orders", "insert").field("item_id", item_id.clone()),
                    WriteExpectation::redis("item:{$steps.put.outputs.itemId}", "incr"),
                ])
                .expect_effect("email", [("to", email.clone()), ("subject", Match::pattern("^Receipt"))]),
        )
        .step(
            Step::new("get", "readItem").parameter(Parameter::Path, "id", item_id.clone()).run_as("viewer@example.test").expect_nothing(),
        );
    let (arazzo, expectations) = journey.documents("store", &open_api(), "/openapi.json", &[]).unwrap();
    let workflow = &arazzo["workflows"][0];
    assert_eq!(arazzo["sourceDescriptions"], json!([{ "name": "storeAPI", "type": "openapi", "url": "/openapi.json" }]));
    assert_eq!(workflow["inputs"]["properties"]["email"]["description"], "Email address for the receipt.");
    assert_eq!(workflow["inputs"]["required"], json!(["email"]));
    assert_eq!(
        workflow["steps"][0]["requestBody"],
        json!({ "contentType": "application/json", "payload": { "buyer": { "email": email } } })
    );
    assert_eq!(workflow["steps"][0]["outputs"], json!({ "itemId": "$response.body#/id" }));
    assert_eq!(workflow["steps"][0]["successCriteria"], json!([{ "condition": "$statusCode == 201" }]));
    assert_eq!(workflow["steps"][1]["parameters"], json!([{ "name": "id", "in": "path", "value": item_id }]));
    let entry = &expectations["journeys"]["receipt"];
    assert_eq!(entry["group"], "Sales");
    assert_eq!(entry["runAs"], "admin@example.test");
    assert_eq!(entry["sendOnly"], true);
    assert!(entry["sendOnlyReason"].as_str().unwrap().contains("redis"));
    assert_eq!(
        entry["steps"]["put"],
        json!({
            "writes": [
                { "store": "sqlite", "table": "items", "op": "update", "key": { "id": item_id },
                  "values": { "status": { "from": "pending", "to": "ready" }, "updated": { "type": "date-time" }, "category": "book" } },
                { "store": "mongodb", "collection": "orders", "op": "insert", "values": { "item_id": item_id } },
                { "store": "redis", "key": "item:{$steps.put.outputs.itemId}", "op": "INCR" }
            ],
            "effects": [{ "kind": "email", "to": email, "subject": { "pattern": "^Receipt" } }],
            "unlisted": "fail"
        })
    );
    assert_eq!(
        entry["steps"]["get"],
        json!({
            "persona": "viewer@example.test", "writes": [], "effects": [], "unlisted": "fail"
        })
    );
    assert_eq!(
        expectations["approvedDifferences"],
        json!([{
            "id": "AD-1", "journey": "receipt", "step": "put", "kind": "value",
            "target": { "store": "sqlite", "table": "items", "field": "category" },
            "expected": "book", "actual": "textbook", "reason": "Renamed in the next release",
            "approvedBy": "reviewer@example.test", "approvedOn": "2026-11-23", "expires": "2027-01-01"
        }])
    );
}

#[test]
fn invalid_journeys_fail_in_development_and_are_skipped_elsewhere() {
    let config = |environment: &str| {
        let invalid = Journey::new("bad", "Invalid journey")
            .step(Step::new("put", "missingOperation").body(json!({
                "unknown": Ref::input("missingInput"),
                "forward": Ref::output("get", "itemId")
            })))
            .step(Step::new("get", "readItem").output("itemId", "/id"));
        let valid = Journey::new("valid", "Valid journey").step(Step::new("get", "readItem"));
        Config::builder("Store API")
            .environment(environment)
            .path_base("/tenant")
            .journey("invalid", invalid, open_api())
            .journey("valid", valid, open_api())
            .open_api_url("/store/openapi.json")
            .build()
    };

    let error = config("Development").err().unwrap().to_string();
    assert!(error.contains("unknown OpenAPI operationId `missingOperation`"), "{error}");
    assert!(error.contains("unknown input `missingInput`"), "{error}");
    assert!(error.contains("invalid output reference `$steps.get.outputs.itemId`"), "{error}");

    let config = config("Production").unwrap();
    assert!(config.journey_document("/journeys/invalid.arazzo.json").is_none());
    let arazzo: Value = serde_json::from_slice(config.journey_document("/journeys/valid.arazzo.json").unwrap()).unwrap();
    assert_eq!(arazzo["sourceDescriptions"][0]["url"], "/tenant/store/openapi.json");
    assert_eq!(
        capabilities(&config, None, &[], "Axum")["journeys"],
        json!([{
            "name": "Valid journey", "source": "code",
            "arazzoUrl": "/tenant/sendproof/journeys/valid.arazzo.json",
            "expectationsUrl": "/tenant/sendproof/journeys/valid.expect.json"
        }])
    );
}

#[test]
fn code_and_file_journeys_share_discovery_and_workflow_ids() {
    let config = |id: &str| {
        let journey = Journey::new(id, "Read an item").step(Step::new("read", "readItem"));
        Config::builder("Store API")
            .environment("Development")
            .journey_file(
                "stored",
                br#"{"sourceDescriptions":[{"type":"openapi","url":"/openapi.json"}],"workflows":[{"workflowId":"stored"}]}"#.to_vec(),
                br#"{"journeys":{}}"#.to_vec(),
            )
            .journey("generated", journey, open_api())
            .build()
    };
    let caps = capabilities(&config("read").unwrap(), None, &[], "Actix");
    assert_eq!(caps["journeys"][0]["source"], "file");
    assert_eq!(caps["journeys"][1]["source"], "code");
    let error = config("stored").err().unwrap().to_string();
    assert!(error.contains("workflow id `stored` is already registered"), "{error}");
}
