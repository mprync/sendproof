package fixture

import "net/http"

// openAPI returns the fixture's OpenAPI 3.1 document. Its schemas describe the
// request and response shapes the handlers use.
func openAPI() map[string]any {
	itemSchema := map[string]any{"$ref": "#/components/schemas/Item"}
	json := func(schema any) map[string]any {
		return map[string]any{"application/json": map[string]any{"schema": schema}}
	}
	idParam := []any{map[string]any{"name": "id", "in": "path", "required": true, "schema": map[string]any{"type": "string"}}}
	response := func(description string, schema any) map[string]any {
		entry := map[string]any{"description": description}
		if schema != nil {
			entry["content"] = json(schema)
		}
		return entry
	}
	action := func(summary string, responses map[string]any) map[string]any {
		return map[string]any{"summary": summary, "parameters": idParam, "responses": responses}
	}
	return map[string]any{
		"openapi": "3.1.0",
		"info":    map[string]any{"title": "Sendproof Conformance", "version": "1.0.0"},
		"paths": map[string]any{
			"/items": map[string]any{"post": map[string]any{
				"summary":     "Create an item",
				"requestBody": map[string]any{"required": true, "content": json(itemSchema)},
				"responses":   map[string]any{"201": response("Created", itemSchema), "400": response("Invalid input", nil)},
			}},
			"/items/{id}": map[string]any{
				"get": action("Read an item", map[string]any{"200": response("The item", itemSchema), "404": response("Not found", nil)}),
				"patch": map[string]any{
					"summary": "Rename an item", "parameters": append(append([]any{}, idParam...), map[string]any{
						"name": "tag", "in": "query", "schema": map[string]any{"type": "string"}}),
					"requestBody": map[string]any{"required": true, "content": json(map[string]any{"$ref": "#/components/schemas/ItemUpdate"})},
					"responses":   map[string]any{"200": response("Updated", itemSchema), "404": response("Not found", nil)},
				},
				"delete": action("Delete an item", map[string]any{"204": response("Deleted", nil)}),
			},
			"/items/{id}/fail":     map[string]any{"post": action("Insert then fail", map[string]any{"409": response("Conflict", nil)})},
			"/items/{id}/large":    map[string]any{"post": action("Insert and return a large body", map[string]any{"200": response("A large text body", nil)})},
			"/items/{id}/redirect": map[string]any{"post": action("Insert and redirect", map[string]any{"302": response("Redirect to the item", nil)})},
			"/items/{id}/capture":  map[string]any{"post": action("Exceed the capture limits", map[string]any{"204": response("Done", nil)})},
			"/items/{id}/ordinary": map[string]any{"post": action("Insert without preview support", map[string]any{"204": response("Done", nil)})},
		},
		"components": map[string]any{"schemas": map[string]any{
			"Item": map[string]any{
				"type": "object", "required": []string{"id", "name"},
				"properties": map[string]any{"id": map[string]any{"type": "string"}, "name": map[string]any{"type": "string"}},
			},
			"ItemUpdate": map[string]any{
				"type": "object", "required": []string{"name"},
				"properties": map[string]any{"name": map[string]any{"type": "string"}},
			},
		}},
	}
}

func serveOpenAPI(w http.ResponseWriter, _ *http.Request) { writeJSON(w, http.StatusOK, openAPI()) }
