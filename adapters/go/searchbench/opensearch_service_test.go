package searchbench_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/mprync/sendproof/adapters/go/searchbench"
	"github.com/mprync/sendproof/adapters/go/sendproof"
	"github.com/opensearch-project/opensearch-go/v4"
	"github.com/opensearch-project/opensearch-go/v4/opensearchapi"
)

// openSearchURL is the compose service
// (docker compose -f tests/conformance/compose.yml --profile heavy-stores up -d --wait opensearch).
func openSearchURL() string {
	if url := os.Getenv("BENCH_OPENSEARCH_SERVER_URL"); url != "" {
		return url
	}
	return "http://127.0.0.1:59200"
}

// liveIndex creates a fresh index through an unguarded client and drops it afterwards.
// The test skips with the compose command when OpenSearch does not answer.
func liveIndex(t *testing.T) (string, *opensearchapi.Client) {
	t.Helper()
	plain, err := opensearchapi.NewClient(opensearchapi.Config{Client: opensearch.Config{Addresses: []string{openSearchURL()}, DisableRetry: true}})
	if err != nil {
		t.Fatal(err)
	}
	random := make([]byte, 4)
	_, _ = rand.Read(random)
	index := "tb_" + hex.EncodeToString(random)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := plain.Indices.Create(ctx, opensearchapi.IndicesCreateReq{Index: index, Body: strings.NewReader(`{"settings":{"number_of_replicas":0}}`)}); err != nil {
		t.Skipf("OpenSearch is not reachable (docker compose -f tests/conformance/compose.yml --profile heavy-stores up -d --wait opensearch): %v", err)
	}
	t.Cleanup(func() {
		_, _ = plain.Indices.Delete(context.Background(), opensearchapi.IndicesDeleteReq{Indices: []string{index}})
	})
	return index, plain
}

// TestAgainstARealOpenSearch runs the guard against a real
// OpenSearch: a read in a Preview runs, a write is refused before it is sent and
// leaves the index unchanged, and without the guard the same write lands.
func TestAgainstARealOpenSearch(t *testing.T) {
	for _, guarded := range []bool{true, false} {
		index, plain := liveIndex(t)
		config := opensearch.Config{Addresses: []string{openSearchURL()}, DisableRetry: true}
		if guarded {
			config.Transport = searchbench.Transport(nil, searchbench.OpenSearch())
		}
		client, err := opensearchapi.NewClient(opensearchapi.Config{Client: config})
		if err != nil {
			t.Fatal(err)
		}
		bench, _ := sendproof.New(sendproof.WithEnvironment("Development"), sendproof.WithDataStore(searchbench.Store("articles", searchbench.OpenSearch())),
			sendproof.WithPrincipal(func(*http.Request) (sendproof.Principal, bool) {
				return sendproof.Principal{Subject: "ada", Scheme: "cookie"}, true
			}))
		mux := http.NewServeMux()
		bench.HandlePreview(mux, "POST /read", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = client.Search(r.Context(), &opensearchapi.SearchReq{Indices: []string{index}, Body: strings.NewReader(`{"query":{"match_all":{}}}`)})
		}))
		bench.HandlePreview(mux, "POST /write", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// The error is swallowed: the Preview must answer 409 anyway.
			_, _ = client.Update(r.Context(), opensearchapi.UpdateReq{
				Index: index, DocumentID: "1", Body: strings.NewReader(`{"doc":{"views":1},"doc_as_upsert":true}`),
				Params: opensearchapi.UpdateParams{Refresh: "true"},
			})
		}))
		preview := func(route string) *httptest.ResponseRecorder {
			request := httptest.NewRequest("POST", "/sendproof/_preview"+route, strings.NewReader(`{}`))
			request.Header.Set("Prefer", "tx=rollback")
			response := httptest.NewRecorder()
			bench.Middleware(mux).ServeHTTP(response, request)
			return response
		}
		if response := preview("/read"); response.Code != 200 {
			t.Fatalf("guarded=%v: a search must run in a Preview: %d %s", guarded, response.Code, response.Body)
		}
		response := preview("/write")
		count, err := plain.Indices.Count(context.Background(), &opensearchapi.IndicesCountReq{Indices: []string{index}})
		if err != nil {
			t.Fatal(err)
		}
		if guarded {
			if response.Code != 409 || count.Count != 0 {
				t.Errorf("a refused update must not reach OpenSearch: %d count=%d", response.Code, count.Count)
			}
		} else if response.Code != 200 || count.Count != 1 {
			t.Errorf("without the guard the update lands: %d count=%d", response.Code, count.Count)
		}
	}
}
