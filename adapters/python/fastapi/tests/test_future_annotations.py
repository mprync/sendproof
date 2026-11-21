from __future__ import annotations

import httpx
from fastapi import FastAPI
from pydantic import BaseModel

from testbench_fastapi import preview


class Payload(BaseModel):
    name: str


async def test_preview_keeps_string_annotations_resolvable():
    """Frameworks resolve annotations through the function's globals; the wrapper must share them."""
    app = FastAPI()

    @app.post("/things")
    @preview
    def create(payload: Payload) -> dict:
        return {"name": payload.name}

    schema = app.openapi()["paths"]["/things"]["post"]["requestBody"]["content"]["application/json"]["schema"]
    assert schema == {"$ref": "#/components/schemas/Payload"}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post("/things", json={"name": "x"})).json() == {"name": "x"}
