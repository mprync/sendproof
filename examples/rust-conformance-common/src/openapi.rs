//! The fixture's OpenAPI 3.0 document.

use serde_json::{Value, json};

fn item_body() -> Value {
    json!({ "required": true, "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Item" } } } })
}

fn ok(status: &str, description: &str) -> Value {
    json!({ status: { "description": description, "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Item" } } } } })
}

fn id_parameter() -> Value {
    json!([{ "name": "id", "in": "path", "required": true, "schema": { "type": "string" } }])
}

fn action(summary: &str, status: &str) -> Value {
    json!({ "post": { "summary": summary, "parameters": id_parameter(), "responses": { status: { "description": summary } } } })
}

pub fn document() -> Value {
    json!({
        "openapi": "3.0.3",
        "info": { "title": "Sendproof Conformance", "version": "1.0.0" },
        "paths": {
            "/items": { "post": {
                "summary": "Create an item", "requestBody": item_body(),
                "responses": { "201": ok("201", "Created")["201"].clone(), "400": { "description": "Invalid item" } }
            } },
            "/items/{id}": {
                "get": { "operationId": "getItem", "summary": "Read an item", "parameters": id_parameter(),
                    "responses": { "200": ok("200", "The item")["200"].clone(), "404": { "description": "Not found" } } },
                "patch": { "summary": "Rename an item", "parameters": id_parameter(),
                    "requestBody": { "required": true, "content": { "application/json": { "schema": {
                        "type": "object", "required": ["name"], "properties": { "name": { "type": "string" } } } } } },
                    "responses": { "200": ok("200", "Renamed")["200"].clone() } },
                "delete": { "summary": "Delete an item", "parameters": id_parameter(), "responses": { "204": { "description": "Deleted" } } }
            },
            "/items/{id}/fail": action("Insert, then fail with a handled 409", "409"),
            "/items/{id}/large": action("Insert, then return an oversized body", "200"),
            "/items/{id}/redirect": action("Insert, then redirect", "302"),
            "/items/{id}/capture": action("Insert many items and record many effects and logs", "200"),
            "/items/{id}/ordinary": action("Insert an item (Send only)", "201")
        },
        "components": { "schemas": { "Item": {
            "type": "object", "required": ["id", "name"],
            "properties": { "id": { "type": "string" }, "name": { "type": "string" } }
        } } }
    })
}
