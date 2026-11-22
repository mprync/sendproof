package cosmosbench_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azcore/policy"
	"github.com/Azure/azure-sdk-for-go/sdk/data/azcosmos"

	"github.com/mprync/sendproof/adapters/go/cosmosbench"
	"github.com/mprync/sendproof/adapters/go/sendproof"
)

// gateway is a fake Cosmos DB gateway as an azcore transport: it records every
// request that reaches it, so a test can prove a refused write never did.
type gateway struct {
	mu       sync.Mutex
	received []string
}

func (g *gateway) Do(req *http.Request) (*http.Response, error) {
	g.mu.Lock()
	g.received = append(g.received, req.Method+" "+req.URL.Path)
	g.mu.Unlock()
	body := `{}`
	if req.URL.Path == "/" {
		body = `{"writableLocations":[{"name":"local","databaseAccountEndpoint":"https://cosmos.test/"}],"readableLocations":[{"name":"local","databaseAccountEndpoint":"https://cosmos.test/"}],"enableMultipleWriteLocations":false}`
	}
	if req.Body != nil {
		_, _ = io.Copy(io.Discard, req.Body)
		_ = req.Body.Close()
	}
	return &http.Response{
		StatusCode: 200, Status: "200 OK", Header: http.Header{"Content-Type": {"application/json"}},
		Body: io.NopCloser(strings.NewReader(body)), Request: req,
	}, nil
}

// requests returns what reached the gateway, without the client's account reads.
func (g *gateway) requests() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	var list []string
	for _, entry := range g.received {
		if entry != "GET /" {
			list = append(list, entry)
		}
	}
	return list
}

// client builds the real azcosmos client over the fake gateway, with or without the guard.
func client(t *testing.T, g *gateway, guarded bool) *azcosmos.Client {
	t.Helper()
	options := &azcosmos.ClientOptions{ClientOptions: azcore.ClientOptions{Transport: g}}
	if guarded {
		options = cosmosbench.ClientOptions(options)
	}
	credential, err := azcosmos.NewKeyCredential("c2VjcmV0LWtleS1mb3ItdGVzdHM=")
	if err != nil {
		t.Fatal(err)
	}
	c, err := azcosmos.NewClientWithKey("https://cosmos.test/", credential, options)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

type operation func(ctx context.Context, container *azcosmos.ContainerClient) error

// app is a bench with one route per operation, each swallowing the store's error and answering 200.
type app struct {
	handler http.Handler
	gateway *gateway
}

func newApp(t *testing.T, guarded bool, routes map[string]operation) *app {
	t.Helper()
	bench, err := sendproof.New(
		sendproof.WithEnvironment("Development"), sendproof.WithDataStore(cosmosbench.Store("orders")),
		sendproof.WithPrincipal(func(*http.Request) (sendproof.Principal, bool) {
			return sendproof.Principal{Subject: "ada", Name: "Ada", Scheme: "cookie"}, true
		}),
	)
	if err != nil {
		t.Fatal(err)
	}
	g := &gateway{}
	// The database and container are derived from the client; they share its pipeline.
	container, err := client(t, g, guarded).NewContainer("shop", "orders")
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	for pattern, run := range routes {
		bench.HandlePreview(mux, pattern, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			if err := run(r.Context(), container); err != nil {
				_ = json.NewEncoder(w).Encode(map[string]any{"swallowed": err.Error()})
				return
			}
			_, _ = w.Write([]byte(`{}`))
		}))
	}
	return &app{handler: bench.Middleware(mux), gateway: g}
}

func (a *app) do(method, path string, headers map[string]string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(`{}`))
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response := httptest.NewRecorder()
	a.handler.ServeHTTP(response, request)
	return response
}

func (a *app) preview(target string) *httptest.ResponseRecorder {
	return a.do("POST", "/sendproof/_preview"+target, map[string]string{"Prefer": "tx=rollback"})
}

func assertBlocked(t *testing.T, response *httptest.ResponseRecorder, operation string) {
	t.Helper()
	var body map[string]any
	_ = json.Unmarshal(response.Body.Bytes(), &body)
	if response.Code != 409 || body["code"] != "preview_unavailable" || body["store"] != "cosmosdb" || body["operation"] != operation ||
		body["detail"] != "Preview unavailable: this operation writes to Cosmos DB" || body["rolledBack"] != false ||
		response.Header().Get("Preference-Applied") != "" {
		t.Fatalf("expected a blocked Preview for %s, got %d %s", operation, response.Code, response.Body)
	}
}

var partition = azcosmos.NewPartitionKeyString("p1")

func writeRoutes() map[string]operation {
	return map[string]operation{
		"POST /create": func(ctx context.Context, c *azcosmos.ContainerClient) error {
			_, err := c.CreateItem(ctx, partition, []byte(`{"id":"o-2","note":"secret"}`), nil)
			return err
		},
		"POST /upsert": func(ctx context.Context, c *azcosmos.ContainerClient) error {
			_, err := c.UpsertItem(ctx, partition, []byte(`{"id":"o-1"}`), nil)
			return err
		},
		"POST /replace": func(ctx context.Context, c *azcosmos.ContainerClient) error {
			_, err := c.ReplaceItem(ctx, partition, "o-1", []byte(`{"id":"o-1"}`), nil)
			return err
		},
		"POST /patch": func(ctx context.Context, c *azcosmos.ContainerClient) error {
			ops := azcosmos.PatchOperations{}
			ops.AppendSet("/status", "closed")
			_, err := c.PatchItem(ctx, partition, "o-1", ops, nil)
			return err
		},
		"POST /delete": func(ctx context.Context, c *azcosmos.ContainerClient) error {
			_, err := c.DeleteItem(ctx, partition, "o-1", nil)
			return err
		},
		"POST /batch": func(ctx context.Context, c *azcosmos.ContainerClient) error {
			batch := c.NewTransactionalBatch(partition)
			batch.ReadItem("o-1", nil)
			_, err := c.ExecuteTransactionalBatch(ctx, batch, nil)
			return err
		},
	}
}

func TestWritesAreRefusedBeforeTheyAreSent(t *testing.T) {
	a := newApp(t, true, writeRoutes())
	want := map[string]string{
		"/create": "Create", "/upsert": "Upsert", "/replace": "Replace", "/patch": "Patch", "/delete": "Delete", "/batch": "Batch",
	}
	for route, operation := range want {
		assertBlocked(t, a.preview(route), operation)
	}
	if got := a.gateway.requests(); len(got) != 0 {
		t.Errorf("a refused write reached the gateway: %v", got)
	}
}

func TestReadsRunInPreviewAndAreLogged(t *testing.T) {
	a := newApp(t, true, map[string]operation{
		"POST /read": func(ctx context.Context, c *azcosmos.ContainerClient) error {
			_, err := c.ReadItem(ctx, partition, "o-1", nil)
			return err
		},
		"POST /query": func(ctx context.Context, c *azcosmos.ContainerClient) error {
			pager := c.NewQueryItemsPager(`SELECT * FROM c WHERE c.owner = "ada" AND c.n > 7`, partition,
				&azcosmos.QueryOptions{QueryParameters: []azcosmos.QueryParameter{{Name: "@x", Value: "hush"}}})
			_, err := pager.NextPage(ctx)
			return err
		},
	})
	response := a.preview("/read")
	var body map[string]any
	_ = json.Unmarshal(response.Body.Bytes(), &body)
	if response.Code != 200 || body["rolledBack"] != true {
		t.Fatalf("a read must be confirmed: %d %s", response.Code, response.Body)
	}
	logs, _ := body["logs"].([]any)
	var read map[string]any
	for _, entry := range logs {
		if db, _ := entry.(map[string]any)["db"].(map[string]any); db != nil && db["operation"] == "Read" {
			read = db
		}
	}
	if read == nil || read["system"] != "cosmosdb" || read["target"] != "orders" || read["namespace"] != "shop" {
		t.Fatalf("a Read Db entry with the container and database: %v", logs)
	}
	query := a.preview("/query")
	var queryBody struct {
		Logs []struct {
			DB struct{ Operation, Statement string } `json:"db"`
		} `json:"logs"`
	}
	_ = json.Unmarshal(query.Body.Bytes(), &queryBody)
	if query.Code != 200 || len(queryBody.Logs) != 1 || queryBody.Logs[0].DB.Operation != "Query" ||
		queryBody.Logs[0].DB.Statement != `SELECT * FROM c WHERE c.owner = ? AND c.n > ?` {
		t.Errorf("a query's statement keeps its text with literals replaced: %d %s", query.Code, query.Body)
	}
	text := query.Body.String()
	if strings.Contains(text, "hush") || strings.Contains(text, "Authorization") || strings.Contains(text, "c2VjcmV0") {
		t.Errorf("a parameter value or credential reached the capture: %s", text)
	}
}

func TestTheChecksFailWithoutTheGuard(t *testing.T) {
	a := newApp(t, false, writeRoutes())
	response := a.preview("/create")
	if response.Code != 200 {
		t.Fatalf("an unguarded client should have written: %d %s", response.Code, response.Body)
	}
	if got := a.gateway.requests(); len(got) != 1 || got[0] != "POST /dbs/shop/colls/orders/docs" {
		t.Errorf("without the guard the write reaches the gateway: %v", got)
	}
}

func TestSendIsNeverBlockedAndObservedSendTracesTheOperation(t *testing.T) {
	a := newApp(t, true, writeRoutes())
	response := a.do("POST", "/create", map[string]string{"Prefer": "trace"})
	id := response.Header().Get("X-Sendproof-Trace")
	if response.Code != 200 || id == "" || len(a.gateway.requests()) != 1 {
		t.Fatalf("observed send: %d %v %v", response.Code, response.Header(), a.gateway.requests())
	}
	trace := a.do("GET", "/sendproof/_api/traces/"+id, nil).Body.String()
	if !strings.Contains(trace, `"operation":"Create"`) || strings.Contains(trace, "secret") {
		t.Errorf("trace: %s", trace)
	}
	if plain := a.do("POST", "/create", nil); plain.Code != 200 {
		t.Errorf("an ordinary Send was blocked: %d", plain.Code)
	}
}

// TestAWriteWithoutTheRequestContextIsRefusedBeforeItIsSent: a write that carries
// no request while a Preview is open is taken to be the Preview's, and refused.
func TestAWriteWithoutTheRequestContextIsRefusedBeforeItIsSent(t *testing.T) {
	a := newApp(t, true, map[string]operation{
		"POST /background": func(_ context.Context, c *azcosmos.ContainerClient) error {
			_, err := c.UpsertItem(context.Background(), partition, []byte(`{"id":"b"}`), nil)
			return err
		},
	})
	assertBlocked(t, a.preview("/background"), "Upsert")
	if got := a.gateway.requests(); len(got) != 0 {
		t.Errorf("the unattributed write reached the gateway: %v", got)
	}
}

func TestClientOptionsKeepTheCallersPolicies(t *testing.T) {
	var marker policy.Policy = cosmosbench.Policy()
	base := &azcosmos.ClientOptions{ClientOptions: azcore.ClientOptions{PerCallPolicies: []policy.Policy{marker}}}
	got := cosmosbench.ClientOptions(base)
	if len(base.PerCallPolicies) != 1 || len(got.PerCallPolicies) != 2 {
		t.Errorf("the caller's options must not change: base %d, result %d", len(base.PerCallPolicies), len(got.PerCallPolicies))
	}
}

func TestCapabilitiesListTheStoreInGuardMode(t *testing.T) {
	bench, err := sendproof.New(sendproof.WithEnvironment("Development"), sendproof.WithDataStore(cosmosbench.Store("orders")))
	if err != nil {
		t.Fatal(err)
	}
	var body struct {
		DataStores []sendproof.DataStoreInfo `json:"dataStores"`
	}
	response := httptest.NewRecorder()
	bench.Middleware(http.NewServeMux()).ServeHTTP(response, httptest.NewRequest("GET", "/sendproof/_api/capabilities", nil))
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || len(body.DataStores) != 1 ||
		body.DataStores[0] != (sendproof.DataStoreInfo{System: "cosmosdb", Name: "orders", Mode: "guard"}) {
		t.Errorf("dataStores: %+v %v", body.DataStores, err)
	}
}

func TestStoreRefusesAConnectionStringAsALabel(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Error("an account URL must not be accepted as a store name")
		}
	}()
	cosmosbench.Store("https://acct.documents.azure.com:443/")
}
