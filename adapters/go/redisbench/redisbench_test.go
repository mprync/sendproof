package redisbench_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/mprync/sendproof/adapters/go/redisbench"
	"github.com/mprync/sendproof/adapters/go/sendproof"
	"github.com/redis/go-redis/v9"
)

// redisURL is the compose service (docker compose -f tests/conformance/compose.yml up -d redis).
func redisURL() string {
	if url := os.Getenv("BENCH_REDIS_SERVER_URL"); url != "" {
		return url
	}
	return "redis://:bench_redis_local@127.0.0.1:56379"
}

// newClient connects with no retries, and skips the test with the compose command
// when the server does not answer a PING.
func newClient(t *testing.T) *redis.Client {
	t.Helper()
	options, err := redis.ParseURL(redisURL())
	if err != nil {
		t.Fatal(err)
	}
	options.MaxRetries, options.DialTimeout, options.ReadTimeout = -1, 2*time.Second, 2*time.Second
	client := redis.NewClient(options)
	t.Cleanup(func() { _ = client.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := client.Ping(ctx).Err(); err != nil {
		t.Skipf("Redis is not reachable (docker compose -f tests/conformance/compose.yml up -d redis): %v", err)
	}
	return client
}

func prefix() string {
	random := make([]byte, 4)
	_, _ = rand.Read(random)
	return "tb_" + hex.EncodeToString(random) + ":"
}

// app is a bench whose handlers use the hooked client.
type app struct {
	handler http.Handler
	hooked  *redis.Client
	plain   *redis.Client // an unhooked client, for independent reads
	prefix  string
}

// newApp builds the app. hook=false leaves the client unhooked, to prove the checks fail without it.
func newApp(t *testing.T, hook bool, options ...redisbench.Option) *app {
	t.Helper()
	plain := newClient(t)
	// The hooked client has not connected yet: its first command, sent inside a
	// Preview, performs the connection handshake (AUTH, HELLO, CLIENT SETINFO and
	// CLIENT MAINT_NOTIFICATIONS), which must never be mistaken for a write.
	clientOptions, _ := redis.ParseURL(redisURL())
	clientOptions.MaxRetries, clientOptions.DialTimeout, clientOptions.ReadTimeout = -1, 2*time.Second, 2*time.Second
	hooked := redis.NewClient(clientOptions)
	t.Cleanup(func() { _ = hooked.Close() })
	if hook {
		hooked.AddHook(redisbench.Hook(options...))
	}
	bench, err := sendproof.New(
		sendproof.WithEnvironment("Development"), sendproof.WithDataStore(redisbench.Store("cache")),
		sendproof.WithPrincipal(func(*http.Request) (sendproof.Principal, bool) {
			return sendproof.Principal{Subject: "ada", Name: "Ada", Scheme: "cookie"}, true
		}),
	)
	if err != nil {
		t.Fatal(err)
	}
	a := &app{hooked: hooked, plain: plain, prefix: prefix()}
	key := func(r *http.Request) string { return a.prefix + "counter:" + r.PathValue("key") }
	mux := http.NewServeMux()
	reply := func(w http.ResponseWriter, status int, body any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
	}
	bench.HandlePreview(mux, "GET /counters/{key}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		value, err := hooked.Get(r.Context(), key(r)).Int64()
		if err != nil {
			reply(w, 404, map[string]any{"error": err.Error()})
			return
		}
		reply(w, 200, map[string]any{"value": value})
	}))
	bench.HandlePreview(mux, "POST /counters/{key}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		value, err := hooked.Incr(r.Context(), key(r)).Result()
		if err != nil {
			reply(w, 500, map[string]any{"error": err.Error()})
			return
		}
		reply(w, 200, map[string]any{"value": value})
	}))
	// take catches the refusal and still answers 200.
	bench.HandlePreview(mux, "POST /counters/{key}/take", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		value, err := hooked.GetDel(r.Context(), key(r)).Int64()
		if err != nil {
			reply(w, 200, map[string]any{"swallowed": err.Error()})
			return
		}
		reply(w, 200, map[string]any{"value": value})
	}))
	bench.HandlePreview(mux, "POST /pipeline/{key}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, err := hooked.Pipelined(r.Context(), func(p redis.Pipeliner) error {
			p.Get(r.Context(), key(r))
			p.Set(r.Context(), a.prefix+"piped", "x", 0)
			return nil
		})
		reply(w, 200, map[string]any{"error": errString(err)})
	}))
	bench.HandlePreview(mux, "POST /multi/{key}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, err := hooked.TxPipelined(r.Context(), func(p redis.Pipeliner) error {
			p.Set(r.Context(), a.prefix+"multi", "x", 0)
			return nil
		})
		reply(w, 200, map[string]any{"error": errString(err)})
	}))
	// background sends its write with context.Background(): the guard can't see the
	// Preview, so it refuses the write before it is sent and blocks every open Preview.
	bench.HandlePreview(mux, "POST /background/{key}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = hooked.Incr(context.Background(), key(r)).Err()
		w.WriteHeader(200)
	}))
	a.handler = bench.Middleware(mux)
	return a
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
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

func (a *app) preview(method, target string) *httptest.ResponseRecorder {
	return a.do(method, "/sendproof/_preview"+target, map[string]string{"Prefer": "tx=rollback"})
}

func (a *app) exists(t *testing.T, name string) bool {
	t.Helper()
	count, err := a.plain.Exists(context.Background(), a.prefix+name).Result()
	if err != nil {
		t.Fatal(err)
	}
	return count == 1
}

func assertBlocked(t *testing.T, response *httptest.ResponseRecorder, operation string) {
	t.Helper()
	var body map[string]any
	_ = json.Unmarshal(response.Body.Bytes(), &body)
	if response.Code != 409 || body["code"] != "preview_unavailable" || body["store"] != "redis" || body["operation"] != operation ||
		body["detail"] != "Preview unavailable: this operation writes to Redis" || body["rolledBack"] != false ||
		response.Header().Get("Preference-Applied") != "" {
		t.Fatalf("expected a blocked Preview for %s, got %d %v", operation, response.Code, response.Body)
	}
}

func TestReadsRunInPreview(t *testing.T) {
	a := newApp(t, true)
	if err := a.plain.Set(context.Background(), a.prefix+"counter:seeded", 5, time.Minute).Err(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { a.plain.Del(context.Background(), a.prefix+"counter:seeded") })
	response := a.preview("GET", "/counters/seeded")
	var body map[string]any
	_ = json.Unmarshal(response.Body.Bytes(), &body)
	if inner, _ := body["body"].(map[string]any); response.Code != 200 || body["rolledBack"] != true || inner["value"] != float64(5) {
		t.Fatalf("a read must be confirmed: %d %s", response.Code, response.Body)
	}
	logs, _ := body["logs"].([]any)
	if len(logs) != 1 {
		t.Fatalf("expected one Db entry (the PING and AUTH of the connection are session commands): %v", logs)
	}
	entry := logs[0].(map[string]any)["db"].(map[string]any)
	if entry["system"] != "redis" || entry["operation"] != "GET" || entry["statement"] != "GET "+a.prefix+"counter:seeded" {
		t.Errorf("Db entry: %v", entry)
	}
}

func TestWritesAreRefusedBeforeAnyByteIsSent(t *testing.T) {
	a := newApp(t, true)
	t.Cleanup(func() { a.plain.Del(context.Background(), a.prefix+"counter:seeded", a.prefix+"counter:new") })
	if err := a.plain.Set(context.Background(), a.prefix+"counter:seeded", 5, time.Minute).Err(); err != nil {
		t.Fatal(err)
	}
	assertBlocked(t, a.preview("POST", "/counters/new"), "INCR")
	if a.exists(t, "counter:new") {
		t.Error("INCR reached Redis")
	}
	// GETDEL looks like a read but deletes; the handler swallows the error and answers 200.
	assertBlocked(t, a.preview("POST", "/counters/seeded/take"), "GETDEL")
	if !a.exists(t, "counter:seeded") {
		t.Error("GETDEL reached Redis")
	}
}

func TestPipelinesAndTransactionsAreClassifiedAsAWhole(t *testing.T) {
	a := newApp(t, true)
	assertBlocked(t, a.preview("POST", "/pipeline/x"), "SET")
	if a.exists(t, "piped") {
		t.Error("a pipelined SET reached Redis")
	}
	assertBlocked(t, a.preview("POST", "/multi/x"), "SET")
	if a.exists(t, "multi") {
		t.Error("a MULTI/EXEC SET reached Redis")
	}
	// The connection is still usable: the refusal corrupted no reply matching.
	if err := a.hooked.Ping(context.Background()).Err(); err != nil {
		t.Errorf("the client broke after a refused pipeline: %v", err)
	}
}

func TestTheChecksFailWithoutTheHook(t *testing.T) {
	a := newApp(t, false)
	t.Cleanup(func() { a.plain.Del(context.Background(), a.prefix+"counter:new") })
	response := a.preview("POST", "/counters/new")
	if response.Code != 200 || !a.exists(t, "counter:new") {
		t.Fatalf("an unhooked client should have written: %d", response.Code)
	}
}

func TestObservedSendCommitsOnceAndTracesTheCommand(t *testing.T) {
	a := newApp(t, true)
	t.Cleanup(func() { a.plain.Del(context.Background(), a.prefix+"counter:sent") })
	response := a.do("POST", "/counters/sent", map[string]string{"Prefer": "trace"})
	id := response.Header().Get("X-Sendproof-Trace")
	if response.Code != 200 || id == "" {
		t.Fatalf("observed send: %d %v", response.Code, response.Header())
	}
	value, err := a.plain.Get(context.Background(), a.prefix+"counter:sent").Result()
	if err != nil || value != "1" {
		t.Errorf("observed Send must commit exactly once: %q %v", value, err)
	}
	trace := a.do("GET", "/sendproof/_api/traces/"+id, nil)
	text := trace.Body.String()
	if !strings.Contains(text, `"operation":"INCR"`) || strings.Contains(text, "bench_redis_local") {
		t.Errorf("trace: %s", text)
	}
	// An ordinary request is never blocked.
	if plain := a.do("POST", "/counters/sent", nil); plain.Code != 200 {
		t.Errorf("an ordinary Send was blocked: %d", plain.Code)
	}
}

func TestHostDeclaredReadsAreAllowed(t *testing.T) {
	a := newApp(t, true, redisbench.TreatAsRead("INCR"))
	t.Cleanup(func() { a.plain.Del(context.Background(), a.prefix+"counter:declared") })
	if response := a.preview("POST", "/counters/declared"); response.Code != 200 {
		t.Fatalf("a host-declared read must not block: %d %s", response.Code, response.Body)
	}
}

func TestCapabilitiesListTheStoreInGuardMode(t *testing.T) {
	a := newApp(t, true)
	var body struct {
		DataStores []sendproof.DataStoreInfo `json:"dataStores"`
	}
	response := a.do("GET", "/sendproof/_api/capabilities", nil)
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || len(body.DataStores) != 1 ||
		body.DataStores[0] != (sendproof.DataStoreInfo{System: "redis", Name: "cache", Mode: "guard"}) {
		t.Errorf("dataStores: %+v %v", body.DataStores, err)
	}
	if strings.Contains(response.Body.String(), "127.0.0.1") || strings.Contains(response.Body.String(), "bench_redis_local") {
		t.Error("discovery leaked connection details")
	}
}

func TestStoreRefusesAConnectionStringAsALabel(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Error("a URL must not be accepted as a store name")
		}
	}()
	redisbench.Store("redis://:secret@host:6379")
}

// TestAWriteWithoutTheRequestContextIsRefusedBeforeItIsSent: a write that carries
// no request while a Preview is open is taken to be the Preview's, and refused.
func TestAWriteWithoutTheRequestContextIsRefusedBeforeItIsSent(t *testing.T) {
	a := newApp(t, true)
	t.Cleanup(func() { a.plain.Del(context.Background(), a.prefix+"counter:b") })
	assertBlocked(t, a.preview("POST", "/background/b"), "INCR")
	if a.exists(t, "counter:b") {
		t.Error("the unattributed write reached Redis")
	}
	// Work in a detached scope is never refused, and an ordinary request's writes are not unattributed.
	if err := a.hooked.Incr(sendproof.Detached(context.Background()), a.prefix+"counter:b").Err(); err != nil {
		t.Errorf("a detached write must run: %v", err)
	}
}
