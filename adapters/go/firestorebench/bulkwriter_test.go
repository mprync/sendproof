package firestorebench_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"cloud.google.com/go/firestore"

	"github.com/mprync/sendproof/adapters/go/firestorebench"
	"github.com/mprync/sendproof/adapters/go/sendproof"
)

// TestABulkWriterRefusesAQueuedWriteOnTheCallersGoroutine: a long-lived guarded
// BulkWriter, created for background work, refuses a write queued during a
// Preview (with the request's context or none) in the queueing call, before the
// writer's goroutine could send it with the writer's own (detached) context.
// Outside a Preview the write is queued and sent.
func TestABulkWriterRefusesAQueuedWriteOnTheCallersGoroutine(t *testing.T) {
	s := newServer(t)
	client, err := firestore.NewClient(context.Background(), "bench", s.options(true)...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	writer := firestorebench.NewBulkWriter(sendproof.Detached(context.Background()), client)
	bench, err := sendproof.New(sendproof.WithEnvironment("Development"), sendproof.WithDataStore(firestorebench.Store("orders")),
		sendproof.WithPrincipal(func(*http.Request) (sendproof.Principal, bool) {
			return sendproof.Principal{Subject: "a", Scheme: "cookie"}, true
		}))
	if err != nil {
		t.Fatal(err)
	}
	doc := func(id string) *firestore.DocumentRef { return client.Collection("orders").Doc(id) }
	var refused []error
	mux := http.NewServeMux()
	bench.HandlePreview(mux, "POST /queue", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, err := writer.Set(r.Context(), doc("a"), map[string]any{"a": 1})
		refused = append(refused, err)
		_, err = writer.Create(context.Background(), doc("b"), map[string]any{"b": 1})
		refused = append(refused, err)
		_, err = writer.Update(r.Context(), doc("c"), []firestore.Update{{Path: "c", Value: 1}})
		refused = append(refused, err)
		_, err = writer.Delete(r.Context(), doc("d"))
		refused = append(refused, err)
	}))
	request := httptest.NewRequest("POST", "/sendproof/_preview/queue", strings.NewReader(`{}`))
	request.Header.Set("Prefer", "tx=rollback")
	response := httptest.NewRecorder()
	bench.Middleware(mux).ServeHTTP(response, request)
	assertBlocked(t, response, "BatchWrite")
	for index, err := range refused {
		var blocked *sendproof.PreviewWriteBlockedError
		if !errors.As(err, &blocked) {
			t.Errorf("write %d must be refused when queued: %v", index, err)
		}
	}
	writer.Flush()
	for _, method := range s.requests() {
		if method == "BatchWrite" {
			t.Fatalf("a refused write was queued and sent: %v", s.requests())
		}
	}
	job, err := writer.Set(sendproof.Detached(context.Background()), doc("e"), map[string]any{"e": 1})
	if err != nil {
		t.Fatalf("outside a Preview the write must be queued: %v", err)
	}
	writer.End()
	if _, err := job.Results(); err != nil {
		t.Errorf("the queued write must be sent: %v", err)
	}
	if got := s.requests(); len(got) == 0 || got[len(got)-1] != "BatchWrite" {
		t.Errorf("the write must reach the server: %v", got)
	}
}
