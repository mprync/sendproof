from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.applications import Starlette
from starlette.routing import Mount

from sendproof_core.journey_builder import JourneyBuilder, JourneyDefinitionError
from sendproof_fastapi import Sendproof


def fixture_app():
    app = FastAPI(openapi_url="/api-schema.json")

    @app.get("/items/{id}", operation_id="readItem")
    def read(id: str):
        return {"id": id}

    return app


def invalid_journey():
    journey = JourneyBuilder("invalid")
    first = journey.step("first", "noSuchOperation")
    second = journey.step("second", "readItem")
    first.set("id", second.output("itemId", "/id"), in_="path")
    second.set("id", journey.input("typo"), in_="path")
    return journey


def test_development_reports_journey_errors_before_serving():
    with pytest.raises(JourneyDefinitionError) as caught:
        Sendproof(fixture_app(), environment="Development", journeys=[invalid_journey()])
    message = str(caught.value)
    assert "Unknown operationId 'noSuchOperation'" in message
    assert "Unknown input 'typo'" in message
    assert "Bad step reference '$steps.second.outputs.itemId'" in message


def test_other_enabled_environments_skip_invalid_journeys(caplog):
    app = fixture_app()
    good = JourneyBuilder("good")
    good.step("read", "readItem").set("id", "widget", in_="path")
    Sendproof(app, environment="Staging", environments=["Staging"], journeys=[invalid_journey(), good])
    with TestClient(app) as client:
        entry, = client.get("/sendproof/_api/capabilities").json()["journeys"]
        assert entry["name"] == "good"
        assert client.get("/sendproof/journeys/invalid.arazzo.json").status_code == 404
    assert "Skipped a code journey: invalid" in caplog.text


def test_code_and_file_journeys_share_mounted_discovery():
    app = fixture_app()
    good = JourneyBuilder("good")
    good.step("read", "readItem").set("id", "widget", in_="path")
    file = Path(__file__).resolve().parents[2] / "conformance/journeys/conformance.arazzo.json"
    Sendproof(app, environment="Development", journeys=[good], journey_files=[file])
    with TestClient(Starlette(routes=[Mount("/tenant", app=app)])) as client:
        capabilities = client.get("/tenant/sendproof/_api/capabilities").json()
        entries = {entry["source"]: entry for entry in capabilities["journeys"]}
        assert set(entries) == {"code", "file"}
        code = entries["code"]
        assert code["arazzoUrl"] == "/tenant/sendproof/journeys/good.arazzo.json"
        document = client.get(code["arazzoUrl"]).json()
        assert document["sourceDescriptions"][0]["url"] == capabilities["openApiUrl"] == "/tenant/api-schema.json"
        assert client.get(code["expectationsUrl"]).json()["arazzo"] == "good.arazzo.json"
        assert client.get(entries["file"]["arazzoUrl"]).status_code == 200
