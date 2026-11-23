package sendproof_test

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/mprync/sendproof/adapters/go/sendproof"
)

func journeyOpenAPI(w http.ResponseWriter, _ *http.Request) {
	_, _ = io.WriteString(w, `{"openapi":"3.1.0","paths":{"/items":{"post":{"operationId":"createItem"}},"/items/{id}":{"patch":{"operationId":"updateItem"}}}}`)
}

func TestCodeJourneyStartupValidation(t *testing.T) {
	type inputs struct {
		Name string `json:"name"`
	}
	bad := sendproof.Journey{ID: "broken", Inputs: inputs{}, Steps: []sendproof.JourneyStep{
		{ID: "wrongOperation", OperationID: "noSuchItem"},
		{ID: "unknownInput", OperationID: "createItem", Parameters: []sendproof.JourneyParameter{
			{Name: "id", In: "query", Value: sendproof.Input("missing")},
		}},
		{ID: "forwardReference", OperationID: "updateItem", Body: &sendproof.JourneyBody{
			Payload: []any{map[string]string{"id": sendproof.StepOutput("create", "id")}},
		}},
		{ID: "create", OperationID: "createItem", Outputs: map[string]string{"id": sendproof.ResponseBody("/id")}},
		{ID: "unknownOutput", OperationID: "updateItem", Parameters: []sendproof.JourneyParameter{
			{Name: "id", In: "path", Value: sendproof.StepOutput("create", "unknown")},
		}},
	}}
	good := sendproof.Journey{ID: "working", Steps: []sendproof.JourneyStep{{ID: "create", OperationID: "createItem"}}}
	option := sendproof.WithCodeJourneys(http.HandlerFunc(journeyOpenAPI), sendproof.JourneyDocument{
		ID: "items", Name: "Item journeys", Journeys: []sendproof.Journey{bad, good},
	})
	_, err := sendproof.New(option, sendproof.WithEnvironment("Development"))
	if err == nil {
		t.Fatal("Development startup accepted an invalid journey")
	}
	problems := []string{`unknown operationId "noSuchItem"`, `unknown input "missing"`, `unknown or later step "create"`, `unknown output "unknown"`}
	for _, problem := range problems {
		if !strings.Contains(err.Error(), problem) {
			t.Errorf("startup error lacks %q: %v", problem, err)
		}
	}
	var warnings bytes.Buffer
	file := fstest.MapFS{
		"existing.arazzo.json": {Data: []byte(`{"info":{"title":"An existing journey"},"sourceDescriptions":[]}`)},
		"existing.expect.json": {Data: []byte(`{"sendproofExpectations":"1.0","arazzo":"existing.arazzo.json","journeys":{}}`)},
	}
	bench, err := sendproof.New(option,
		sendproof.WithJourneys(file, "existing.arazzo.json"),
		sendproof.WithEnabledEnvironments("Staging"), sendproof.WithEnvironment("Staging"),
		sendproof.WithOpenAPIURL("/openapi.json"),
		sendproof.WithLogger(slog.New(slog.NewTextHandler(&warnings, nil))),
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(bench.Close)
	if !strings.Contains(warnings.String(), "Skipped a code journey") || !strings.Contains(warnings.String(), "items/broken") {
		t.Errorf("missing skip diagnostic: %s", &warnings)
	}
	response := httptest.NewRecorder()
	bench.Middleware(http.NotFoundHandler()).ServeHTTP(response, httptest.NewRequest("GET", "/sendproof/_api/capabilities", nil))
	var capabilities struct{ Journeys []struct{ Source string } }
	if err := json.Unmarshal(response.Body.Bytes(), &capabilities); err != nil {
		t.Fatal(err)
	}
	if docs := capabilities.Journeys; len(docs) != 2 || docs[0].Source != "file" || docs[1].Source != "code" {
		t.Errorf("expected file and code documents, got %+v", docs)
	}
	response = httptest.NewRecorder()
	bench.Middleware(http.NotFoundHandler()).ServeHTTP(response, httptest.NewRequest("GET", "/sendproof/journeys/items.arazzo.json", nil))
	var doc struct {
		Workflows []struct{ WorkflowID string }
	}
	if err := json.Unmarshal(response.Body.Bytes(), &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Workflows) != 1 || doc.Workflows[0].WorkflowID != "working" {
		t.Errorf("expected only the valid workflow, got %+v", doc.Workflows)
	}
}

func TestCodeJourneyWritesAndBindings(t *testing.T) {
	type inputs struct {
		Name string `json:"name" jsonschema:"description=Item name"`
	}
	itemID := sendproof.StepOutput("create", "id")
	key := map[string]any{"id": itemID}
	journey := sendproof.Journey{
		ID: "createAndUpdate", Group: "Items", RunAs: "writer@example.test", Inputs: inputs{},
		Steps: []sendproof.JourneyStep{
			{ID: "create", OperationID: "createItem", Body: &sendproof.JourneyBody{Payload: map[string]any{"name": sendproof.Input("name")}},
				Outputs: map[string]string{"id": sendproof.ResponseBody("/id")}, SuccessCriteria: []sendproof.JourneyCriterion{sendproof.StatusIs(201)},
				ExpectWrites: &sendproof.StepWrites{Writes: []sendproof.WriteExpectation{{Store: "sqlite", Table: "items", Op: "insert", Key: key}}},
			},
			{ID: "update", OperationID: "updateItem", RunAs: "editor@example.test", Parameters: []sendproof.JourneyParameter{{Name: "id", In: "path", Value: itemID}},
				ExpectWrites: &sendproof.StepWrites{
					Writes: []sendproof.WriteExpectation{
						{Store: "mongodb", Collection: "items", Op: "update", Key: key, Values: map[string]any{"status": sendproof.Changed("new", "ready"), "timestamp": sendproof.Any("date-time")}},
						{Store: "redis", Key: "item:{" + itemID + "}", Op: "INCR"},
					},
					Effects: []sendproof.EffectExpectation{sendproof.Email("writer@example.test", sendproof.Pattern("^Updated"))},
					ApprovedDifferences: []sendproof.ApprovedDifference{{ID: "AD-1", Kind: "value", Expected: "ready", Actual: "active",
						Target: sendproof.DifferenceTarget{Store: "mongodb", Collection: "items", Field: "status"},
						Reason: "Pending migration", ApprovedBy: "owner@example.test", ApprovedOn: "2026-11-23",
					}},
				},
			},
		},
	}
	bench, err := sendproof.New(sendproof.WithEnvironment("Development"),
		sendproof.WithCodeJourneys(http.HandlerFunc(journeyOpenAPI), sendproof.JourneyDocument{
			ID: "items", Name: "Items", Journeys: []sendproof.Journey{journey},
		}),
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(bench.Close)
	handler := bench.Middleware(http.NotFoundHandler())
	for file, want := range map[string][]string{
		"items.arazzo.json": {`"operationId":"createItem"`, `"contentType":"application/json","payload":{"name":"$inputs.name"}`,
			`"outputs":{"id":"$response.body#/id"}`, `"value":"$steps.create.outputs.id"`, `"required":["name"]`},
		"items.expect.json": {`"group":"Items"`, `"runAs":"writer@example.test"`, `"persona":"editor@example.test"`, `"sendOnly":true`,
			`"store":"sqlite","table":"items"`, `"collection":"items","op":"update"`, `"key":"item:{$steps.create.outputs.id}"`,
			`"status":{"from":"new","to":"ready"}`, `"timestamp":{"type":"date-time"}`, `"subject":{"pattern":"^Updated"}`,
			`"target":{"store":"mongodb","collection":"items","field":"status"}`, `"journey":"createAndUpdate","step":"update"`},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest("GET", "/sendproof/journeys/"+file, nil))
		if response.Code != http.StatusOK {
			t.Fatalf("GET %s returned %d", file, response.Code)
		}
		for _, field := range want {
			if !strings.Contains(response.Body.String(), field) {
				t.Errorf("%s lacks %s\n%s", file, field, response.Body)
			}
		}
	}
}
