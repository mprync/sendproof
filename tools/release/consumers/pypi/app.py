"""Smoke-test consumer for the packed PyPI wheels.

A minimal FastAPI application that mounts the Test Bench workbench at /bench/ (development
environment) next to the application's own /openapi.json, listening on 127.0.0.1:$PORT.
tools/release/pypi.mjs copies this file into a throwaway project and installs the wheels from
artifacts/packages/pypi before running it.
"""

from __future__ import annotations

import os

import uvicorn
from fastapi import FastAPI
from pydantic import BaseModel
from testbench_fastapi import TestBench

app = FastAPI(title="Packed Consumer", openapi_url="/openapi.json")


class Item(BaseModel):
    id: str
    name: str


@app.get("/items/{item_id}", response_model=Item)
def read_item(item_id: str) -> Item:
    return Item(id=item_id, name="Example")


TestBench(app, environment="Development")

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ["PORT"]), log_level="warning")
