package searchbench_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/elastic/go-elasticsearch/v8"
	"github.com/elastic/go-elasticsearch/v8/esutil"
	"github.com/mprync/sendproof/adapters/go/searchbench"
	"github.com/mprync/sendproof/adapters/go/sendproof"
	"github.com/opensearch-project/opensearch-go/v4"
	"github.com/opensearch-project/opensearch-go/v4/opensearchapi"
	"github.com/opensearch-project/opensearch-go/v4/opensearchutil"
)

// indexer is one bulk indexer under test: add queues an item with ctx, close flushes.
type indexer struct {
	add   func(ctx context.Context) error
	close func(ctx context.Context) error
}

func esIndexer(t *testing.T, c *cluster, guarded bool) indexer {
	t.Helper()
	client, err := elasticsearch.NewClient(elasticsearch.Config{Addresses: []string{c.URL}})
	if err != nil {
		t.Fatal(err)
	}
	client.Transport = searchbench.ElasticsearchTransport(client.Transport)
	bulk, err := esutil.NewBulkIndexer(esutil.BulkIndexerConfig{Client: client, Index: "articles", FlushInterval: time.Hour, NumWorkers: 1})
	if err != nil {
		t.Fatal(err)
	}
	if guarded {
		bulk = searchbench.ElasticsearchBulkIndexer(bulk)
	}
	return indexer{
		add: func(ctx context.Context) error {
			return bulk.Add(ctx, esutil.BulkIndexerItem{Action: "index", Body: strings.NewReader(`{"title":"queued"}`)})
		},
		close: bulk.Close,
	}
}

func osIndexer(t *testing.T, c *cluster, guarded bool) indexer {
	t.Helper()
	client, err := opensearchapi.NewClient(opensearchapi.Config{Client: opensearch.Config{Addresses: []string{c.URL}}})
	if err != nil {
		t.Fatal(err)
	}
	client.Client.Transport = searchbench.OpenSearchTransport(client.Client.Transport)
	bulk, err := opensearchutil.NewBulkIndexer(opensearchutil.BulkIndexerConfig{Client: client, Index: "articles", FlushInterval: time.Hour, NumWorkers: 1})
	if err != nil {
		t.Fatal(err)
	}
	if guarded {
		bulk = searchbench.OpenSearchBulkIndexer(bulk)
	}
	return indexer{
		add: func(ctx context.Context) error {
			return bulk.Add(ctx, opensearchutil.BulkIndexerItem{Action: "index", Body: strings.NewReader(`{"title":"queued"}`)})
		},
		close: bulk.Close,
	}
}

// previewOnce runs handler as a Preview and returns the response.
func previewOnce(t *testing.T, store sendproof.DataStore, handler http.HandlerFunc) *httptest.ResponseRecorder {
	t.Helper()
	bench, err := sendproof.New(sendproof.WithEnvironment("Development"), sendproof.WithDataStore(store),
		sendproof.WithPrincipal(func(*http.Request) (sendproof.Principal, bool) {
			return sendproof.Principal{Subject: "a", Scheme: "cookie"}, true
		}))
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	bench.HandlePreview(mux, "POST /run", handler)
	request := httptest.NewRequest("POST", "/sendproof/_preview/run", strings.NewReader(`{}`))
	request.Header.Set("Prefer", "tx=rollback")
	response := httptest.NewRecorder()
	bench.Middleware(mux).ServeHTTP(response, request)
	return response
}

// TestABulkIndexerRefusesAQueuedItemOnTheCallersGoroutine: a guarded indexer's Add
// refuses an item during a Preview, with the request's context or none, before it
// is queued, so nothing is left to flush and Close returns at once. Outside a
// Preview the item is queued and sent.
func TestABulkIndexerRefusesAQueuedItemOnTheCallersGoroutine(t *testing.T) {
	for _, engine := range []struct {
		name  string
		build func(*testing.T, *cluster, bool) indexer
		store sendproof.DataStore
	}{
		{"elasticsearch", esIndexer, searchbench.Store("")},
		{"opensearch", osIndexer, searchbench.Store("", searchbench.OpenSearch())},
	} {
		for _, background := range []bool{false, true} {
			c := newCluster(t)
			bulk := engine.build(t, c, true)
			var refused error
			response := previewOnce(t, engine.store, func(w http.ResponseWriter, r *http.Request) {
				ctx := r.Context()
				if background {
					ctx = context.Background()
				}
				refused = bulk.add(ctx)
			})
			var blocked *sendproof.PreviewWriteBlockedError
			if response.Code != 409 || !errors.As(refused, &blocked) || blocked.Store != engine.name || blocked.Operation != "bulk" {
				t.Fatalf("%s background=%v: Add must refuse the item: %d %v", engine.name, background, response.Code, refused)
			}
			closing, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			if err := bulk.close(closing); err != nil {
				t.Errorf("%s: Close after a refused item: %v", engine.name, err)
			}
			cancel()
			if got := c.requests(); len(got) != 0 {
				t.Errorf("%s background=%v: a refused item was sent: %v", engine.name, background, got)
			}
		}
		c := newCluster(t)
		bulk := engine.build(t, c, true)
		if err := bulk.add(context.Background()); err != nil {
			t.Fatalf("%s: outside a Preview the item must be queued: %v", engine.name, err)
		}
		_ = bulk.close(context.Background())
		if got := c.requests(); len(got) != 1 || !strings.HasSuffix(got[0], "/_bulk") {
			t.Errorf("%s: the queued item must be sent: %v", engine.name, got)
		}
	}
}

// TestARawBulkIndexerFlushedDuringAPreviewNeitherSendsNorHangs: an unwrapped
// indexer is only guarded when it sends. Its flush, with the indexer's own
// context, is refused while a Preview is open; the refusal is above the client's
// retries, so Close returns instead of retrying.
func TestARawBulkIndexerFlushedDuringAPreviewNeitherSendsNorHangs(t *testing.T) {
	for name, build := range map[string]func(*testing.T, *cluster, bool) indexer{"elasticsearch": esIndexer, "opensearch": osIndexer} {
		c := newCluster(t)
		bulk := build(t, c, false)
		var closed error
		response := previewOnce(t, searchbench.Store(""), func(w http.ResponseWriter, r *http.Request) {
			if err := bulk.add(r.Context()); err != nil {
				t.Errorf("%s: a raw indexer queues the item: %v", name, err)
			}
			closing, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			closed = bulk.close(closing)
		})
		if errors.Is(closed, context.DeadlineExceeded) {
			t.Fatalf("%s: Close hung on a refused flush", name)
		}
		if response.Code != 409 {
			t.Errorf("%s: the refused flush must block the open Preview: %d %s", name, response.Code, response.Body)
		}
		if got := c.requests(); len(got) != 0 {
			t.Errorf("%s: the refused flush was sent: %v", name, got)
		}
	}
}
