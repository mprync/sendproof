package searchbench_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/elastic/go-elasticsearch/v8"
	"github.com/elastic/go-elasticsearch/v8/esapi"
	"github.com/mprync/sendproof/adapters/go/searchbench"
	"github.com/mprync/sendproof/adapters/go/sendproof"
	"github.com/opensearch-project/opensearch-go/v4"
	"github.com/opensearch-project/opensearch-go/v4/opensearchapi"
)

// cluster is a fake cluster that records every request it receives, so a test can
// prove a refused write never reached the wire.
type cluster struct {
	*httptest.Server
	mu       sync.Mutex
	received []string
}

func newCluster(t *testing.T) *cluster {
	t.Helper()
	c := &cluster{}
	c.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c.mu.Lock()
		c.received = append(c.received, r.Method+" "+r.URL.Path)
		c.mu.Unlock()
		w.Header().Set("X-Elastic-Product", "Elasticsearch")
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/":
			_, _ = w.Write([]byte(`{"name":"fake","version":{"number":"8.15.0","build_flavor":"default"},"tagline":"You Know, for Search"}`))
		case strings.HasSuffix(r.URL.Path, "/_search"):
			_, _ = w.Write([]byte(`{"took":1,"timed_out":false,"hits":{"total":{"value":0,"relation":"eq"},"hits":[]}}`))
		default:
			_, _ = w.Write([]byte(`{"result":"ok","acknowledged":true}`))
		}
	}))
	t.Cleanup(c.Close)
	return c
}

// requests returns what reached the cluster, ignoring the clients' product check.
func (c *cluster) requests() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	var list []string
	for _, entry := range c.received {
		if entry != "GET /" {
			list = append(list, entry)
		}
	}
	return list
}

// app is a bench whose handlers use the guarded clients.
type app struct {
	handler http.Handler
	cluster *cluster
}

// operation is one store call a test route makes with the request's context.
type operation func(ctx context.Context) error

// newApp builds the app with a route per operation. hooked=false builds the clients
// without the guard, to prove the checks fail without it.
func newApp(t *testing.T, hooked bool, openSearch bool, routes map[string]operation) *app {
	t.Helper()
	bench, err := sendproof.New(
		sendproof.WithEnvironment("Development"), sendproof.WithDataStore(searchbench.Store("articles")),
		sendproof.WithPrincipal(func(*http.Request) (sendproof.Principal, bool) {
			return sendproof.Principal{Subject: "ada", Name: "Ada", Scheme: "cookie"}, true
		}),
	)
	if err != nil {
		t.Fatal(err)
	}
	c := newCluster(t)
	mux := http.NewServeMux()
	for pattern, run := range routes {
		bench.HandlePreview(mux, pattern, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Swallow the error: the Preview must answer 409 whatever the handler does.
			err := run(r.Context())
			w.Header().Set("Content-Type", "application/json")
			if err != nil {
				_ = json.NewEncoder(w).Encode(map[string]any{"swallowed": err.Error()})
				return
			}
			_, _ = w.Write([]byte(`{}`))
		}))
	}
	a := &app{handler: bench.Middleware(mux), cluster: c}
	return a
}

// elastic and opensearch build the real clients of each library against the fake cluster.
func elastic(t *testing.T, c *cluster, hooked bool) (*elasticsearch.Client, *elasticsearch.TypedClient) {
	t.Helper()
	config := elasticsearch.Config{Addresses: []string{c.URL}, DisableRetry: true}
	if hooked {
		config.Transport = searchbench.Transport(nil)
	}
	client, err := elasticsearch.NewClient(config)
	if err != nil {
		t.Fatal(err)
	}
	typed, err := elasticsearch.NewTypedClient(config)
	if err != nil {
		t.Fatal(err)
	}
	return client, typed
}

func opensearchClient(t *testing.T, c *cluster, hooked bool) *opensearchapi.Client {
	t.Helper()
	config := opensearch.Config{Addresses: []string{c.URL}, DisableRetry: true}
	if hooked {
		config.Transport = searchbench.Transport(nil, searchbench.OpenSearch())
	}
	client, err := opensearchapi.NewClient(opensearchapi.Config{Client: config})
	if err != nil {
		t.Fatal(err)
	}
	return client
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

func assertBlocked(t *testing.T, response *httptest.ResponseRecorder, store, display, operation string) {
	t.Helper()
	var body map[string]any
	_ = json.Unmarshal(response.Body.Bytes(), &body)
	if response.Code != 409 || body["code"] != "preview_unavailable" || body["store"] != store || body["operation"] != operation ||
		body["detail"] != "Preview unavailable: this operation writes to "+display || body["rolledBack"] != false ||
		response.Header().Get("Preference-Applied") != "" {
		t.Fatalf("expected a blocked Preview for %s, got %d %s", operation, response.Code, response.Body)
	}
}

// discard closes a response body, whichever client's response it is, and returns err.
func discard(response any, err error) error {
	switch typed := response.(type) {
	case *esapi.Response:
		if typed != nil && typed.Body != nil {
			_ = typed.Body.Close()
		}
	case *http.Response:
		if typed != nil && typed.Body != nil {
			_ = typed.Body.Close()
		}
	}
	return err
}

// writes are the calls the guard must refuse, one per route, through the real
// go-elasticsearch client: typed methods of esapi and a raw Perform.
func writeRoutes(t *testing.T, a func() (*elasticsearch.Client, *elasticsearch.TypedClient)) map[string]operation {
	body := func() *bytes.Reader { return bytes.NewReader([]byte(`{"title":"secret title"}`)) }
	client := func() *elasticsearch.Client { c, _ := a(); return c }
	return map[string]operation{
		"POST /index": func(ctx context.Context) error {
			return discard(client().Index("articles", body(), client().Index.WithContext(ctx), client().Index.WithDocumentID("1")))
		},
		"POST /bulk": func(ctx context.Context) error {
			return discard(client().Bulk(strings.NewReader("{\"index\":{\"_index\":\"articles\"}}\n{\"title\":\"x\"}\n"), client().Bulk.WithContext(ctx)))
		},
		"POST /delete": func(ctx context.Context) error {
			return discard(client().Delete("articles", "1", client().Delete.WithContext(ctx)))
		},
		"POST /update": func(ctx context.Context) error {
			return discard(client().Update("articles", "1", strings.NewReader(`{"doc":{"views":2}}`), client().Update.WithContext(ctx)))
		},
		"POST /updatebyquery": func(ctx context.Context) error {
			return discard(client().UpdateByQuery([]string{"articles"}, client().UpdateByQuery.WithContext(ctx)))
		},
		"POST /deletebyquery": func(ctx context.Context) error {
			return discard(client().DeleteByQuery([]string{"articles"}, strings.NewReader(`{"query":{"match_all":{}}}`), client().DeleteByQuery.WithContext(ctx)))
		},
		"POST /reindex": func(ctx context.Context) error {
			return discard(client().Reindex(strings.NewReader(`{"source":{"index":"a"},"dest":{"index":"b"}}`), client().Reindex.WithContext(ctx)))
		},
		"POST /create-index": func(ctx context.Context) error {
			return discard(client().Indices.Create("fresh", client().Indices.Create.WithContext(ctx)))
		},
		"POST /perform-put": func(ctx context.Context) error {
			request, _ := http.NewRequestWithContext(ctx, "PUT", "/articles/_settings", strings.NewReader(`{}`))
			return discard(client().Perform(request))
		},
		"POST /typed-index": func(ctx context.Context) error {
			_, typed := a()
			_, err := typed.Index("articles").Id("1").Request(map[string]any{"title": "x"}).Do(ctx)
			return err
		},
	}
}

func TestWritesAreRefusedBeforeTheyAreSent(t *testing.T) {
	var current *app
	routes := writeRoutes(t, func() (*elasticsearch.Client, *elasticsearch.TypedClient) { return elastic(t, current.cluster, true) })
	current = newApp(t, true, false, routes)
	want := map[string]string{
		"/index": "index", "/bulk": "bulk", "/delete": "delete", "/update": "update", "/updatebyquery": "update_by_query",
		"/deletebyquery": "delete_by_query", "/reindex": "reindex", "/create-index": "indices.create",
		"/perform-put": "indices.put_settings", "/typed-index": "index",
	}
	for route, operation := range want {
		assertBlocked(t, current.preview(route), "elasticsearch", "Elasticsearch", operation)
	}
	if got := current.cluster.requests(); len(got) != 0 {
		t.Errorf("a refused write reached the cluster: %v", got)
	}
}

func TestReadsRunInPreviewAndAreLogged(t *testing.T) {
	var current *app
	current = newApp(t, true, false, map[string]operation{
		"POST /search": func(ctx context.Context) error {
			client, _ := elastic(t, current.cluster, true)
			return discard(client.Search(client.Search.WithContext(ctx), client.Search.WithIndex("articles"),
				client.Search.WithBody(strings.NewReader(`{"query":{"term":{"title":"secret title"}}}`))))
		},
		"POST /get": func(ctx context.Context) error {
			client, _ := elastic(t, current.cluster, true)
			return discard(client.Get("articles", "doc-42", client.Get.WithContext(ctx)))
		},
		"POST /typed-search": func(ctx context.Context) error {
			_, typed := elastic(t, current.cluster, true)
			_, err := typed.Search().Index("articles").Do(ctx)
			return err
		},
	})
	response := current.preview("/search")
	var body map[string]any
	_ = json.Unmarshal(response.Body.Bytes(), &body)
	if response.Code != 200 || body["rolledBack"] != true {
		t.Fatalf("a read must be confirmed: %d %s", response.Code, response.Body)
	}
	text := response.Body.String()
	if strings.Contains(text, "secret title") {
		t.Errorf("a request value reached the capture: %s", text)
	}
	logs, _ := body["logs"].([]any)
	if len(logs) != 1 {
		t.Fatalf("want one Db entry (the product check is not a command): %v", logs)
	}
	entry := logs[0].(map[string]any)["db"].(map[string]any)
	if entry["system"] != "elasticsearch" || entry["operation"] != "search" || entry["target"] != "articles" ||
		entry["statement"] != `{"query":{"term":{"title":"?"}}}` {
		t.Errorf("Db entry: %v", entry)
	}
	if got := current.cluster.requests(); len(got) != 1 || got[0] != "POST /articles/_search" {
		t.Errorf("the read must reach the cluster once: %v", got)
	}
	// A document id is in the path only: it never appears in the capture.
	getResponse := current.preview("/get")
	if getResponse.Code != 200 || strings.Contains(getResponse.Body.String(), "doc-42") {
		t.Errorf("get: %d %s", getResponse.Code, getResponse.Body)
	}
	if typed := current.preview("/typed-search"); typed.Code != 200 {
		t.Errorf("typed search: %d %s", typed.Code, typed.Body)
	}
}

func TestOpenSearchClientReportsItself(t *testing.T) {
	var current *app
	current = newApp(t, true, true, map[string]operation{
		"POST /write": func(ctx context.Context) error {
			_, err := opensearchClient(t, current.cluster, true).Document.Create(ctx, opensearchapi.DocumentCreateReq{Index: "articles", DocumentID: "1", Body: strings.NewReader(`{"a":1}`)})
			return err
		},
		"POST /read": func(ctx context.Context) error {
			_, err := opensearchClient(t, current.cluster, true).Search(ctx, &opensearchapi.SearchReq{Indices: []string{"articles"}})
			return err
		},
	})
	assertBlocked(t, current.preview("/write"), "opensearch", "OpenSearch", "create")
	if got := current.cluster.requests(); len(got) != 0 {
		t.Errorf("a refused write reached the cluster: %v", got)
	}
	if response := current.preview("/read"); response.Code != 200 {
		t.Errorf("an OpenSearch read must run: %d %s", response.Code, response.Body)
	}
}

func TestTheChecksFailWithoutTheHook(t *testing.T) {
	var current *app
	routes := writeRoutes(t, func() (*elasticsearch.Client, *elasticsearch.TypedClient) { return elastic(t, current.cluster, false) })
	current = newApp(t, false, false, routes)
	response := current.preview("/index")
	if response.Code != 200 {
		t.Fatalf("an unguarded client should have written: %d %s", response.Code, response.Body)
	}
	if got := current.cluster.requests(); len(got) != 1 || got[0] != "PUT /articles/_doc/1" {
		t.Errorf("without the hook the write reaches the cluster: %v", got)
	}
}

func TestSendIsNeverBlockedAndObservedSendTracesTheRequest(t *testing.T) {
	var current *app
	current = newApp(t, true, false, map[string]operation{
		"POST /index": func(ctx context.Context) error {
			client, _ := elastic(t, current.cluster, true)
			return discard(client.Index("articles", strings.NewReader(`{"title":"hush"}`), client.Index.WithContext(ctx)))
		},
	})
	response := current.do("POST", "/index", map[string]string{"Prefer": "trace"})
	id := response.Header().Get("X-Sendproof-Trace")
	if response.Code != 200 || id == "" {
		t.Fatalf("observed send: %d %v", response.Code, response.Header())
	}
	if got := current.cluster.requests(); len(got) != 1 {
		t.Errorf("an observed Send must commit exactly once: %v", got)
	}
	trace := current.do("GET", "/sendproof/_api/traces/"+id, nil).Body.String()
	if !strings.Contains(trace, `"operation":"index"`) || strings.Contains(trace, "hush") {
		t.Errorf("trace: %s", trace)
	}
	if plain := current.do("POST", "/index", nil); plain.Code != 200 {
		t.Errorf("an ordinary Send was blocked: %d", plain.Code)
	}
}

// TestAWriteWithoutTheRequestContextIsRefusedBeforeItIsSent: a write that carries
// no request while a Preview is open is taken to be the Preview's, and refused;
// detached work is never refused.
func TestAWriteWithoutTheRequestContextIsRefusedBeforeItIsSent(t *testing.T) {
	var current *app
	current = newApp(t, true, false, map[string]operation{
		"POST /background": func(context.Context) error {
			client, _ := elastic(t, current.cluster, true)
			return discard(client.Index("articles", strings.NewReader(`{}`), client.Index.WithContext(context.Background())))
		},
	})
	assertBlocked(t, current.preview("/background"), "elasticsearch", "Elasticsearch", "index")
	if got := current.cluster.requests(); len(got) != 0 {
		t.Errorf("the unattributed write reached the cluster: %v", got)
	}
	detached := newApp(t, true, false, map[string]operation{
		"POST /job": func(context.Context) error {
			client, _ := elastic(t, current.cluster, true)
			return discard(client.Index("articles", strings.NewReader(`{}`), client.Index.WithContext(sendproof.Detached(context.Background()))))
		},
	})
	if response := detached.preview("/job"); response.Code != 200 {
		t.Errorf("a detached write must not fail a Preview: %d %s", response.Code, response.Body)
	}
}

func TestSQLEndpointsReadOnlyForASingleSelect(t *testing.T) {
	var current *app
	query := func(text string) operation {
		return func(ctx context.Context) error {
			client, _ := elastic(t, current.cluster, true)
			payload, _ := json.Marshal(map[string]string{"query": text})
			return discard(client.SQL.Query(bytes.NewReader(payload), client.SQL.Query.WithContext(ctx)))
		}
	}
	current = newApp(t, true, false, map[string]operation{
		"POST /select": query("SELECT title FROM articles"),
		"POST /delete": query("SELECT 1; DELETE FROM articles"),
	})
	if response := current.preview("/select"); response.Code != 200 {
		t.Errorf("a SELECT must run: %d %s", response.Code, response.Body)
	}
	assertBlocked(t, current.preview("/delete"), "elasticsearch", "Elasticsearch", "sql.query")
}

func TestAPathPrefixIsRemovedBeforeClassifying(t *testing.T) {
	var seen []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Method+" "+r.URL.Path)
		w.Header().Set("X-Elastic-Product", "Elasticsearch")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()
	bench, _ := sendproof.New(sendproof.WithEnvironment("Development"), sendproof.WithDataStore(searchbench.Store("")),
		sendproof.WithPrincipal(func(*http.Request) (sendproof.Principal, bool) {
			return sendproof.Principal{Subject: "a", Scheme: "cookie"}, true
		}))
	client, err := elasticsearch.NewClient(elasticsearch.Config{
		Addresses: []string{server.URL + "/proxy"}, DisableRetry: true,
		Transport: searchbench.Transport(nil, searchbench.PathPrefix("/proxy")),
	})
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	bench.HandlePreview(mux, "POST /read", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = discard(client.Search(client.Search.WithContext(r.Context()), client.Search.WithIndex("a"), client.Search.WithBody(strings.NewReader(`{}`))))
	}))
	handler := bench.Middleware(mux)
	request := httptest.NewRequest("POST", "/sendproof/_preview/read", strings.NewReader(`{}`))
	request.Header.Set("Prefer", "tx=rollback")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != 200 {
		t.Errorf("a prefixed POST _search must be a read once the prefix is declared: %d %s", response.Code, response.Body)
	}
}

func TestCapabilitiesListEachEngineInGuardMode(t *testing.T) {
	for _, c := range []struct {
		options []searchbench.Option
		system  string
	}{{nil, "elasticsearch"}, {[]searchbench.Option{searchbench.OpenSearch()}, "opensearch"}} {
		bench, err := sendproof.New(sendproof.WithEnvironment("Development"), sendproof.WithDataStore(searchbench.Store("articles", c.options...)))
		if err != nil {
			t.Fatal(err)
		}
		var body struct {
			DataStores []sendproof.DataStoreInfo `json:"dataStores"`
		}
		response := httptest.NewRecorder()
		bench.Middleware(http.NewServeMux()).ServeHTTP(response, httptest.NewRequest("GET", "/sendproof/_api/capabilities", nil))
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || len(body.DataStores) != 1 ||
			body.DataStores[0] != (sendproof.DataStoreInfo{System: c.system, Name: "articles", Mode: "guard"}) {
			t.Errorf("%s dataStores: %+v %v", c.system, body.DataStores, err)
		}
	}
}

func TestStoreRefusesAConnectionStringAsALabel(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Error("a URL must not be accepted as a store name")
		}
	}()
	searchbench.Store("https://elastic:secret@host:9200")
}

// TestARefusedWriteDoesNotMarkANodeDead: go-elasticsearch's connection pool treats
// a transport error as a failed node. A refusal must not take the cluster out of
// rotation for the reads that follow.
func TestARefusedWriteDoesNotMarkANodeDead(t *testing.T) {
	first, second := newCluster(t), newCluster(t)
	client, err := elasticsearch.NewClient(elasticsearch.Config{
		Addresses: []string{first.URL, second.URL}, DisableRetry: true, Transport: searchbench.Transport(nil),
	})
	if err != nil {
		t.Fatal(err)
	}
	bench, _ := sendproof.New(sendproof.WithEnvironment("Development"), sendproof.WithDataStore(searchbench.Store("")),
		sendproof.WithPrincipal(func(*http.Request) (sendproof.Principal, bool) {
			return sendproof.Principal{Subject: "a", Scheme: "cookie"}, true
		}))
	var after []error
	mux := http.NewServeMux()
	bench.HandlePreview(mux, "POST /write", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for range 4 {
			_ = discard(client.Index("a", strings.NewReader(`{}`), client.Index.WithContext(r.Context())))
		}
		for range 4 {
			after = append(after, discard(client.Search(client.Search.WithContext(r.Context()))))
		}
	}))
	request := httptest.NewRequest("POST", "/sendproof/_preview/write", strings.NewReader(`{}`))
	request.Header.Set("Prefer", "tx=rollback")
	bench.Middleware(mux).ServeHTTP(httptest.NewRecorder(), request)
	for _, err := range after {
		if err != nil {
			t.Errorf("a read after a refused write failed: %v", err)
		}
	}
}

// TestRetriesNeverSendARefusedWrite: with go-elasticsearch's default retries the
// client calls the transport again after an error; the guard refuses every attempt.
func TestRetriesNeverSendARefusedWrite(t *testing.T) {
	var current *app
	current = newApp(t, true, false, map[string]operation{
		"POST /index": func(ctx context.Context) error {
			client, err := elasticsearch.NewClient(elasticsearch.Config{Addresses: []string{current.cluster.URL}, Transport: searchbench.Transport(nil)})
			if err != nil {
				return err
			}
			return discard(client.Index("articles", strings.NewReader(`{}`), client.Index.WithContext(ctx)))
		},
	})
	assertBlocked(t, current.preview("/index"), "elasticsearch", "Elasticsearch", "index")
	if got := current.cluster.requests(); len(got) != 0 {
		t.Errorf("a retried write reached the cluster: %v", got)
	}
}
