import json
from datetime import date
from pathlib import Path

from jsonschema import Draft202012Validator
from pydantic import BaseModel, Field

import fixture_journeys
from sendproof_core import BenchOptions
from sendproof_core.journey_builder import ApprovedDifference, JourneyBuilder, Match
from sendproof_core.workbench import Workbench

PYTHON = Path(__file__).resolve().parents[2]
FIXTURES = PYTHON / "conformance" / "journeys"
SCHEMA = PYTHON.parents[1] / "tests/Sendproof.Journeys.Tests/Schemas/arazzo-1.1-2026-04-15.schema.json"
OPENAPI = {"paths": {
    "/items/{id}": {"get": {"operationId": "readItem"}},
    "/items": {"post": {"operationId": "addItem"}},
}}


def build(journey):
    bench = Workbench(BenchOptions(environment="Development", journeys=(journey,)), journey_openapi=lambda: OPENAPI)
    document = bench.journeys[journey.file_name]
    schema = json.loads(SCHEMA.read_bytes())
    Draft202012Validator(schema).validate(document.arazzo)
    return document


def test_conformance_code_journey_matches_existing_files():
    document = build(fixture_journeys.item_lookup())
    assert document.arazzo == json.loads((FIXTURES / "conformance.arazzo.json").read_bytes())
    assert document.expectations == json.loads((FIXTURES / "conformance.expect.json").read_bytes())


def test_typed_inputs_bindings_and_expectations():
    class Inputs(BaseModel):
        item_name: str = Field(description="Name on the label")
        notify: bool = False

    journey = JourneyBuilder("addAndRead", name="Add and read", inputs=Inputs, group="Items", run_as="owner@example.test")
    add = journey.step("add", "addItem")
    add.request_body({"item": {"name": journey.input("item_name")}, "notify": journey.input("notify")})
    add.succeeds_with(201)
    item_id = add.output("itemId", "/id")
    writes = add.expect_writes()
    writes.sql("items", "insert", store="sqlite", key={"id": item_id},
               values={"name": journey.input("item_name"), "createdAt": Match.any("date-time")})
    writes.mongo("items", "update", key={"id": item_id}, values={"status": Match.changed("new", "ready")})
    writes.redis(f"item:{{{item_id}}}", "SET")
    writes.email(to="owner@example.test", subject=Match.pattern("^Ready"))
    read = journey.step("read", "readItem", run_as="viewer@example.test")
    read.set("id", item_id, in_="path")
    read.success_criterion("$response.body#/id != null")
    read.expect_writes()
    journey.send_only("Updates the Redis cache")
    journey.approve(ApprovedDifference(
        "AD-1", "add", {"store": "sqlite", "table": "items", "field": "name"}, "Known default",
        "owner@example.test", date(2026, 11, 23), expected=None, actual="seed", expires=date(2026, 12, 31),
    ))

    document = build(journey)
    workflow = document.arazzo["workflows"][0]
    assert workflow["inputs"]["required"] == ["item_name"]
    assert workflow["inputs"]["properties"]["item_name"]["description"] == "Name on the label"
    assert workflow["inputs"]["properties"]["notify"]["default"] is False
    assert workflow["steps"][0]["requestBody"]["payload"]["item"] == {"name": "$inputs.item_name"}
    assert workflow["steps"][0]["outputs"] == {"itemId": "$response.body#/id"}
    assert workflow["steps"][1]["parameters"] == [{"name": "id", "in": "path", "value": "$steps.add.outputs.itemId"}]
    assert workflow["steps"][1]["operationId"] == "readItem"
    assert document.expectations["journeys"]["addAndRead"] == {
        "group": "Items", "runAs": "owner@example.test", "sendOnly": True, "sendOnlyReason": "Updates the Redis cache",
        "steps": {
            "add": {
                "writes": [
                    {"store": "sqlite", "op": "insert", "table": "items", "key": {"id": item_id},
                     "values": {"name": "$inputs.item_name", "createdAt": {"type": "date-time"}}},
                    {"store": "mongodb", "op": "update", "collection": "items", "key": {"id": item_id},
                     "values": {"status": {"from": "new", "to": "ready"}}},
                    {"store": "redis", "op": "SET", "key": "item:{$steps.add.outputs.itemId}"},
                ],
                "effects": [{"kind": "email", "to": "owner@example.test", "subject": {"pattern": "^Ready"}}],
                "unlisted": "fail",
            },
            "read": {"writes": [], "effects": [], "unlisted": "fail", "persona": "viewer@example.test"},
        },
    }
    assert document.expectations["approvedDifferences"] == [{
        "id": "AD-1", "journey": "addAndRead", "step": "add", "kind": "value",
        "target": {"store": "sqlite", "table": "items", "field": "name"}, "reason": "Known default",
        "approvedBy": "owner@example.test", "approvedOn": "2026-11-23", "expires": "2026-12-31",
        "expected": None, "actual": "seed",
    }]
