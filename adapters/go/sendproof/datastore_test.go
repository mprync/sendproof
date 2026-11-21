package sendproof_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mprync/sendproof/adapters/go/sendproof"
)

// fakeStore is a hooked store with a transaction of its own: it counts the
// lifecycle so tests can prove an abort always happens.
type fakeStore struct {
	mu                      sync.Mutex
	begun, finished, closed int
	finishErr               error
	panics                  bool // Finish and Close panic, like a store hook with a bug
}

func (s *fakeStore) Describe(context.Context) sendproof.DataStoreInfo {
	return sendproof.DataStoreInfo{System: "redis", Name: "cache", Mode: sendproof.ModeGuard}
}

func (s *fakeStore) BeginPreview(context.Context) (sendproof.StorePreview, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.begun++
	return &fakeStorePreview{store: s}, nil
}

type fakeStorePreview struct{ store *fakeStore }

func (p *fakeStorePreview) Finish(ctx context.Context) error {
	// A store reports what it captured through the Preview scope: Finish must get
	// the context of this Preview.
	sendproof.RecordChange(ctx, sendproof.Change{Operation: "insert", Store: "redis", Table: "counter", Key: map[string]any{"key": "counter:a"}, After: map[string]any{"value": 1}})
	p.store.mu.Lock()
	defer p.store.mu.Unlock()
	p.store.finished++
	if p.store.panics {
		panic("the store's abort crashed")
	}
	return p.store.finishErr
}

func (p *fakeStorePreview) Close() error {
	p.store.mu.Lock()
	defer p.store.mu.Unlock()
	p.store.closed++
	if p.store.panics {
		panic("the store's release crashed")
	}
	return nil
}

// storeApp is an application whose routes talk to the fake store through the guard.
type storeApp struct {
	handler http.Handler
	store   *fakeStore
	bench   *sendproof.Sendproof
}

// write is what a hook does for a write: ask the guard, then pretend to send.
func write(ctx context.Context, sent *int) error {
	if err := sendproof.Guard(ctx, "redis", "INCR", true, ""); err != nil {
		return err
	}
	*sent++
	return nil
}

// newStoreApp builds the app. guarded=false simulates a hook that was removed.
func newStoreApp(t *testing.T, sent *int, guarded bool, options ...sendproof.Option) *storeApp {
	t.Helper()
	store := &fakeStore{}
	bench, err := sendproof.New(append([]sendproof.Option{
		sendproof.WithEnvironment("Development"), sendproof.WithDataStore(store),
	}, options...)...)
	if err != nil {
		t.Fatal(err)
	}
	send := func(ctx context.Context) error {
		if !guarded {
			*sent++
			return nil
		}
		return write(ctx, sent)
	}
	mux := http.NewServeMux()
	bench.HandlePreview(mux, "POST /write", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := send(r.Context()); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusCreated)
	}))
	// swallow catches the refusal and answers 200: the mark must still win.
	bench.HandlePreview(mux, "POST /swallow", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = send(r.Context())
		_, _ = w.Write([]byte("fine"))
	}))
	bench.HandlePreview(mux, "POST /panic", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := send(r.Context()); err != nil {
			panic(err)
		}
	}))
	bench.HandlePreview(mux, "POST /fault", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = sendproof.RefusePreview(r.Context(), "the handler tried to commit")
		_, _ = w.Write([]byte("fine"))
	}))
	bench.HandlePreview(mux, "POST /both", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = send(r.Context())
		_ = sendproof.RefusePreview(r.Context(), "the handler tried to commit")
	}))
	bench.HandlePreview(mux, "POST /read", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = sendproof.Guard(r.Context(), "redis", "GET", false, "")
		sendproof.RecordDb(r.Context(), sendproof.DbCall{
			System: "redis", Operation: "GET", Target: "counter:a", Statement: "GET counter:a", RowsAffected: 1, Duration: time.Millisecond,
		})
		sendproof.RecordChange(r.Context(), sendproof.Change{
			Operation: "update", Store: "mongodb", Namespace: "catalog", Table: "documents", Key: map[string]any{"_id": "d"},
			Before: map[string]any{"_id": "d", "profile": map[string]any{"city": "Leeds", "api_key": "k-1"}, "password_hash": "h"},
			After:  map[string]any{"_id": "d", "profile": map[string]any{"city": "York", "api_key": "k-2"}, "password_hash": "h"},
			Via:    "upsert",
		})
		_, _ = w.Write([]byte("fine"))
	}))
	bench.HandleUnavailable(mux, "DELETE /sessions/{id}", "", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}), sendproof.ForStores("redis"))
	return &storeApp{handler: bench.Middleware(mux), store: store, bench: bench}
}

func (a *storeApp) preview(path string) *httptest.ResponseRecorder {
	request := httptest.NewRequest("POST", "/sendproof/_preview"+path, strings.NewReader(`{}`))
	request.Header.Set("Prefer", "tx=rollback")
	response := httptest.NewRecorder()
	a.handler.ServeHTTP(response, request)
	return response
}

func assertBlocked(t *testing.T, response *httptest.ResponseRecorder) {
	t.Helper()
	if response.Code != 409 || response.Header().Get("Content-Type") != "application/problem+json" ||
		response.Header().Get("Preference-Applied") != "" || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("expected a blocked Preview, got %d %v %s", response.Code, response.Header(), response.Body)
	}
	body := decode(t, response)
	want := map[string]any{
		"type": "about:blank", "title": "Preview unavailable", "status": float64(409), "code": "preview_unavailable",
		"detail": "Preview unavailable: this operation writes to Redis", "store": "redis", "operation": "INCR", "rolledBack": false,
	}
	for key, value := range want {
		if body[key] != value {
			t.Errorf("%s = %v, want %v", key, body[key], value)
		}
	}
	if len(body) != len(want) {
		t.Errorf("the blocked response carries extra members: %v", body)
	}
}

func TestBlockedPreviewAnswers409WhatEverTheHandlerDoes(t *testing.T) {
	for _, path := range []string{"/write", "/swallow", "/panic"} {
		var sent int
		app := newStoreApp(t, &sent, true)
		response := app.preview(path)
		assertBlocked(t, response)
		if sent != 0 {
			t.Errorf("%s: a blocked write reached the store", path)
		}
		if app.store.begun != 1 || app.store.finished != 1 || app.store.closed != 1 {
			t.Errorf("%s: the store transaction was not aborted and released: %+v", path, app.store)
		}
	}
}

// TestGuardChecksFailWhenTheHookIsRemoved is the negative test: without the guard
// the same request is confirmed and the write reaches the store.
func TestGuardChecksFailWhenTheHookIsRemoved(t *testing.T) {
	var sent int
	app := newStoreApp(t, &sent, false)
	response := app.preview("/swallow")
	if response.Code != 200 || sent != 1 {
		t.Fatalf("the unguarded run should have been confirmed with the write sent: %d sent=%d", response.Code, sent)
	}
}

func TestGuardNeverBlocksSendOrReads(t *testing.T) {
	var sent int
	app := newStoreApp(t, &sent, true)
	request := httptest.NewRequest("POST", "/write", strings.NewReader(`{}`))
	response := httptest.NewRecorder()
	app.handler.ServeHTTP(response, request)
	if response.Code != 201 || sent != 1 {
		t.Fatalf("an ordinary send was blocked: %d sent=%d", response.Code, sent)
	}
	if err := sendproof.Guard(context.Background(), "redis", "INCR", true, ""); err != nil {
		t.Errorf("the guard must do nothing outside a request: %v", err)
	}
}

func TestTransactionControlFaultOutranksEverything(t *testing.T) {
	for _, path := range []string{"/fault", "/both"} {
		var sent int
		app := newStoreApp(t, &sent, true)
		response := app.preview(path)
		if response.Code != 500 || response.Header().Get("Preference-Applied") != "" {
			t.Errorf("%s: want 500 without confirmation, got %d %s", path, response.Code, response.Body)
		}
	}
}

func TestFailedStoreAbortWithholdsConfirmation(t *testing.T) {
	var sent int
	app := newStoreApp(t, &sent, true)
	app.store.finishErr = errors.New("abort failed")
	if response := app.preview("/read"); response.Code != 500 {
		t.Fatalf("a failed abort must answer 500, got %d %s", response.Code, response.Body)
	}
	app.store.finishErr = errors.New("abort failed")
	if response := app.preview("/write"); response.Code != 500 {
		t.Fatalf("a failed abort outranks a blocked write, got %d", response.Code)
	}
	if app.store.closed != 2 {
		t.Error("the store was not released after a failed abort")
	}
}

// A store hook that panics while aborting must not skip the SQL rollback or the
// other cleanup, and the Preview answers 500 without confirmation.
func TestAStorePanicStillRollsBackSQLAndWithholdsConfirmation(t *testing.T) {
	var sent int
	provider := &fakeProvider{}
	app := newStoreApp(t, &sent, true, sendproof.WithProvider(provider))
	app.store.panics = true
	var response *httptest.ResponseRecorder
	func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				t.Fatalf("a store panic escaped the Preview pipeline: %v", recovered)
			}
		}()
		response = app.preview("/read")
	}()
	if response.Code != 500 || response.Header().Get("Preference-Applied") != "" || strings.Contains(response.Body.String(), "rolledBack") {
		t.Fatalf("want 500 without confirmation, got %d %s", response.Code, response.Body)
	}
	if provider.rolledBack != 1 || provider.closed != 1 || app.store.closed != 1 {
		t.Errorf("cleanup was skipped: rolledBack=%d closed=%d storeClosed=%d", provider.rolledBack, provider.closed, app.store.closed)
	}
}

func TestPreviewRunsWithoutASQLProviderWhenStoresAreRegistered(t *testing.T) {
	var sent int
	app := newStoreApp(t, &sent, true)
	response := app.preview("/read")
	if response.Code != 200 || response.Header().Get("Preference-Applied") != "tx=rollback" {
		t.Fatalf("a store-only Preview was refused: %d %s", response.Code, response.Body)
	}
	body := decode(t, response)
	if body["rolledBack"] != true || app.store.finished != 1 {
		t.Errorf("not rolled back: %v", body)
	}
	changes := body["changes"].([]any)
	if len(changes) != 2 {
		t.Fatalf("changes recorded in the handler and in Finish: %v", changes)
	}
	if finish := changes[1].(map[string]any); finish["store"] != "redis" || finish["table"] != "counter" {
		t.Errorf("a change recorded by Finish is missing: %v", changes)
	}
	change := changes[0].(map[string]any)
	if change["store"] != "mongodb" || change["namespace"] != "catalog" || change["table"] != "documents" || change["via"] != "upsert" {
		t.Errorf("store fields: %v", change)
	}
	after := change["after"].(map[string]any)
	if after["password_hash"] != "[REDACTED]" || after["profile"].(map[string]any)["api_key"] != "[REDACTED]" ||
		after["profile"].(map[string]any)["city"] != "York" {
		t.Errorf("secrets must be redacted at any depth: %v", after)
	}
	logs := body["logs"].([]any)
	entry := logs[0].(map[string]any)
	db := entry["db"].(map[string]any)
	if entry["level"] != "Db" || entry["message"] != "GET counter:a" || db["system"] != "redis" || db["statement"] != "GET counter:a" || db["rowsAffected"] != float64(1) {
		t.Errorf("Db entry: %v", entry)
	}
}

func TestStoreRegistrationDiscoveryAndUnavailableOperations(t *testing.T) {
	var sent int
	app := newStoreApp(t, &sent, true, sendproof.WithFramework("chi"))
	request := httptest.NewRequest("GET", "/sendproof/_api/capabilities", nil)
	response := httptest.NewRecorder()
	app.handler.ServeHTTP(response, request)
	capabilities := decode(t, response)
	stores := capabilities["dataStores"].([]any)
	if len(stores) != 1 || stores[0].(map[string]any)["system"] != "redis" || stores[0].(map[string]any)["mode"] != "guard" {
		t.Errorf("dataStores: %v", stores)
	}
	unavailable := capabilities["previewUnavailable"].([]any)[0].(map[string]any)
	if unavailable["method"] != "DELETE" || unavailable["path"] != "/sessions/{id}" ||
		unavailable["reason"] != "Preview unavailable: this operation writes to Redis" {
		t.Errorf("previewUnavailable: %v", unavailable)
	}
	for _, operation := range capabilities["previewOperations"].([]any) {
		if operation.(map[string]any)["method"] == "DELETE" {
			t.Error("an unavailable operation must not be advertised for Preview")
		}
	}
	if binding := capabilities["binding"].(map[string]any); binding["language"] != "go" || binding["framework"] != "chi" {
		t.Errorf("binding: %v", binding)
	}
	if capabilities["database"] != nil {
		t.Errorf("no SQL provider means no database: %v", capabilities["database"])
	}
	// A Preview of the marked-unavailable route finds no operation; the handler never runs.
	preview := httptest.NewRequest("DELETE", "/sendproof/_preview/sessions/1", nil)
	preview.Header.Set("Prefer", "tx=rollback")
	denied := httptest.NewRecorder()
	app.handler.ServeHTTP(denied, preview)
	if denied.Code != 409 || strings.Contains(denied.Body.String(), "preview_unavailable") {
		t.Errorf("an unavailable operation's Preview: %d %s", denied.Code, denied.Body)
	}
}

func TestUnavailableNeedsAReasonOrStores(t *testing.T) {
	bench, _ := sendproof.New()
	defer func() {
		if recover() == nil {
			t.Error("an unavailable operation without a reason or stores must panic")
		}
	}()
	bench.Unavailable("DELETE", "/x", "")
}

// systemProvider is a provider that also names its SQL engine.
type systemProvider struct{ *fakeProvider }

func (systemProvider) System() string { return "sqlite" }

func TestDatabaseNamesItsSystem(t *testing.T) {
	capabilities := func(provider sendproof.Provider) map[string]any {
		bench, err := sendproof.New(sendproof.WithEnvironment("Development"), sendproof.WithProvider(provider))
		if err != nil {
			t.Fatal(err)
		}
		response := httptest.NewRecorder()
		bench.Middleware(http.NotFoundHandler()).ServeHTTP(response, httptest.NewRequest("GET", "/sendproof/_api/capabilities", nil))
		return decode(t, response)
	}
	named := capabilities(systemProvider{&fakeProvider{label: "fixture"}})
	if database, _ := named["database"].(map[string]any); database["name"] != "fixture" || database["system"] != "sqlite" {
		t.Errorf("a provider that names its engine publishes {name, system}: %v", named["database"])
	}
	if binding, _ := named["binding"].(map[string]any); binding["language"] != "go" || binding["framework"] != "net/http" {
		t.Errorf("binding: %v", named["binding"])
	}
	if unlabeled, _ := capabilities(systemProvider{&fakeProvider{label: "postgres://u:p@host/db"}})["database"].(map[string]any); unlabeled["name"] != nil || unlabeled["system"] != "sqlite" {
		t.Errorf("a label that looks like connection details is withheld, the system is still published: %v", unlabeled)
	}
	if plain := capabilities(&fakeProvider{label: "fixture"})["database"]; plain != "fixture" {
		t.Errorf("a provider without a system keeps the plain label: %v", plain)
	}
}

func TestObservedSendRecordsDbEntriesWithoutBlocking(t *testing.T) {
	var sent int
	app := newStoreApp(t, &sent, true, sendproof.WithPrincipal(func(*http.Request) (sendproof.Principal, bool) {
		return sendproof.Principal{Subject: "ada", Name: "Ada", Scheme: "cookie"}, true
	}))
	request := httptest.NewRequest("POST", "/read", strings.NewReader(`{}`))
	request.Header.Set("Prefer", "trace")
	response := httptest.NewRecorder()
	app.handler.ServeHTTP(response, request)
	id := response.Header().Get("X-Sendproof-Trace")
	if response.Code != 200 || id == "" {
		t.Fatalf("observed send: %d %v", response.Code, response.Header())
	}
	trace := httptest.NewRequest("GET", "/sendproof/_api/traces/"+id, nil)
	read := httptest.NewRecorder()
	app.handler.ServeHTTP(read, trace)
	logs := decode(t, read)["logs"].([]any)
	if len(logs) == 0 || logs[0].(map[string]any)["level"] != "Db" {
		t.Errorf("the trace has no Db entry: %v", logs)
	}
}

// A write whose context belongs to no request, such as a handler calling a store
// with context.Background(), cannot be told apart from the Preview's own: while a
// Preview is open it fails that Preview instead of letting it claim a rollback.
func TestAWriteWithoutARequestContextFailsTheOpenPreview(t *testing.T) {
	bench, err := sendproof.New(sendproof.WithEnvironment("Development"), sendproof.WithDataStore(&fakeStore{}))
	if err != nil {
		t.Fatal(err)
	}
	var sent int
	mux := http.NewServeMux()
	bench.HandlePreview(mux, "POST /background", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = write(context.Background(), &sent)
		w.WriteHeader(http.StatusCreated)
	}))
	request := httptest.NewRequest("POST", "/sendproof/_preview/background", strings.NewReader(`{}`))
	request.Header.Set("Prefer", "tx=rollback")
	response := httptest.NewRecorder()
	bench.Middleware(mux).ServeHTTP(response, request)
	if response.Code != 500 || response.Header().Get("Preference-Applied") != "" {
		t.Fatalf("an unattributed write during a Preview must answer 500, got %d %s", response.Code, response.Body)
	}
	// Outside any Preview the same write is untouched.
	if err := write(context.Background(), &sent); err != nil || sent != 2 {
		t.Errorf("a background write outside a Preview was refused: %v sent=%d", err, sent)
	}
}

// Writes of other requests, and background work marked Detached, never fail an
// open Preview.
func TestOtherRequestsAndDetachedWorkNeverFailAnOpenPreview(t *testing.T) {
	bench, err := sendproof.New(sendproof.WithEnvironment("Development"), sendproof.WithDataStore(&fakeStore{}))
	if err != nil {
		t.Fatal(err)
	}
	var sent int
	var mu sync.Mutex
	entered, release := make(chan struct{}), make(chan struct{})
	mux := http.NewServeMux()
	bench.HandlePreview(mux, "POST /wait", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-release
		w.WriteHeader(http.StatusCreated)
	}))
	mux.HandleFunc("POST /send", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		_ = write(r.Context(), &sent)
	})
	handler := bench.Middleware(mux)
	done := make(chan *httptest.ResponseRecorder)
	go func() {
		request := httptest.NewRequest("POST", "/sendproof/_preview/wait", strings.NewReader(`{}`))
		request.Header.Set("Prefer", "tx=rollback")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		done <- response
	}()
	<-entered
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("POST", "/send", nil))
	mu.Lock()
	_ = write(sendproof.Detached(context.Background()), &sent)
	mu.Unlock()
	close(release)
	if response := <-done; response.Code != 200 || sent != 2 {
		t.Fatalf("another request's write failed the Preview: %d sent=%d %s", response.Code, sent, response.Body)
	}
}
