"""Code journeys shared by the FastAPI, Flask and Django fixtures."""

from sendproof_core.journey_builder import JourneyBuilder

def item_lookup() -> JourneyBuilder:
    journey = JourneyBuilder(
        "itemLookup", name="Conformance journeys", summary="Look up an item", file_name="conformance",
        source_name="fixture",
        inputs={"type": "object", "properties": {"id": {"type": "string", "default": "conformance-item"}}},
    )
    get_item = journey.step("getItem", "readItem")
    get_item.set("id", journey.input("id"), in_="path")
    get_item.succeeds_with(200)
    return journey
