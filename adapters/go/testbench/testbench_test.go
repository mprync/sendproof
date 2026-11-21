package testbench_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/test-bench/test-bench/adapters/go/testbench"
)

// fakeProvider records its lifecycle so tests can prove cleanup always happens.
type fakeProvider struct {
	mu           sync.Mutex
	begun        int
	rolledBack   int
	closed       int
	rollbackErr  error
	changes      []testbench.Change
	observations int
}

func (p *fakeProvider) Database() string { return "fixture" }

func (p *fakeProvider) Begin(context.Context) (testbench.Session, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.begun++
	return &fakeSession{provider: p}, nil
}

func (p *fakeProvider) Observe(context.Context) (testbench.Observation, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.observations++
	return &fakeObservation{changes: p.changes}, nil
}

type fakeSession struct{ provider *fakeProvider }

func (s *fakeSession) Rollback(context.Context) error {
	s.provider.mu.Lock()
	defer s.provider.mu.Unlock()
	s.provider.rolledBack++
	return s.provider.rollbackErr
}
func (s *fakeSession) Changes() []testbench.Change { return s.provider.changes }
func (s *fakeSession) ChangesTruncated() bool      { return false }
func (s *fakeSession) Close() error {
	s.provider.mu.Lock()
	defer s.provider.mu.Unlock()
	s.provider.closed++
	return nil
}

type fakeObservation struct{ changes []testbench.Change }

func (o *fakeObservation) Finish(context.Context) ([]testbench.Change, bool, error) {
	return o.changes, false, nil
}
func (o *fakeObservation) Close() error { return nil }

// harness is an application with one marked route and one unmarked route.
type harness struct {
	bench    *testbench.Bench
	provider *fakeProvider
	handler  http.Handler
	ran      map[string]int
	mu       sync.Mutex
}

func (h *harness) count(name string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.ran[name]
}

func newHarness(t *testing.T, base string, options ...testbench.Option) *harness {
	t.Helper()
	h := &harness{provider: &fakeProvider{}, ran: map[string]int{}}
	h.provider.changes = []testbench.Change{{Operation: "insert", Table: "items", Key: map[string]any{"id": "a"}, After: map[string]any{"id": "a"}}}
	principal := func(r *http.Request) (testbench.Principal, bool) {
		if cookie, err := r.Cookie("who"); err == nil {
			return testbench.Principal{Subject: cookie.Value, Name: strings.ToUpper(cookie.Value), Role: "admin", Scheme: "cookie"}, true
		}
		return testbench.Principal{}, false
	}
	all := append([]testbench.Option{
		testbench.WithEnvironment("Development"), testbench.WithAPIName("Fixture"), testbench.WithProvider(h.provider),
		testbench.WithPrincipal(principal), testbench.WithOpenAPIURL("/openapi.json"),
		testbench.WithAuthProvider("Password", "cookie", "/auth/sign-in"),
	}, options...)
	bench, err := testbench.New(all...)
	if err != nil {
		t.Fatal(err)
	}
	h.bench = bench

	logger := slog.New(testbench.SlogHandler(slog.NewTextHandler(io.Discard, nil)))
	mux := http.NewServeMux()
	bench.HandlePreview(mux, "POST /items/{id}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.mu.Lock()
		h.ran["marked"]++
		h.mu.Unlock()
		logger.InfoContext(r.Context(), "created:"+r.PathValue("id"), "id", r.PathValue("id"))
		suppressed := testbench.RecordEmail(r.Context(), "Created item", "a@example.test", []string{"b@example.test"}, "Hi", "Body")
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Set-Cookie", "inner=1")
		w.Header().Set("Location", "/elsewhere")
		w.Header().Set("X-Suppressed", map[bool]string{true: "yes", false: "no"}[suppressed])
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":"` + r.PathValue("id") + `","base":"` + testbench.PathBase(r) + `"}`))
	}))
	bench.HandlePreview(mux, "POST /boom", http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("handler exploded") }))
	bench.HandlePreview(mux, "POST /large", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("x", 2<<20)))
	}))
	bench.HandlePreview(mux, "POST /flood", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for i := 0; i < 600; i++ {
			testbench.Log(r.Context(), "Information", "line")
		}
		for i := 0; i < 150; i++ {
			testbench.RecordEffect(r.Context(), "message", "queued", map[string]any{"n": i})
		}
	}))
	mux.HandleFunc("POST /ordinary/{id}", func(w http.ResponseWriter, r *http.Request) {
		h.mu.Lock()
		h.ran["unmarked"]++
		h.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("/ready", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	h.handler = testbench.StripPathBase(base, bench.Middleware(mux))
	return h
}

func (h *harness) do(method, path string, headers map[string]string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(`{}`))
	request.Host = "example.test"
	for name, value := range headers {
		if name == "Cookie" {
			request.Header.Add("Cookie", value)
			continue
		}
		request.Header.Set(name, value)
	}
	response := httptest.NewRecorder()
	h.handler.ServeHTTP(response, request)
	return response
}

var rollback = map[string]string{"Prefer": "tx=rollback", "Cookie": "who=ada"}

func decode(t *testing.T, response *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var value map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &value); err != nil {
		t.Fatalf("decode %q: %v", response.Body.String(), err)
	}
	return value
}

func TestPreviewConfirmsOnlyAfterRollback(t *testing.T) {
	h := newHarness(t, "/tenant")
	response := h.do("POST", "/tenant/bench/_preview/items/a", rollback)
	if response.Code != 200 {
		t.Fatalf("status %d: %s", response.Code, response.Body)
	}
	for name, want := range map[string]string{"Preference-Applied": "tx=rollback", "Cache-Control": "no-store"} {
		if got := response.Header().Get(name); got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
	if response.Header().Get("Set-Cookie") != "" || !strings.Contains(response.Header().Get("Server-Timing"), "handler;dur=") {
		t.Errorf("unexpected outer headers: %v", response.Header())
	}
	body := decode(t, response)
	if body["rolledBack"] != true || body["status"] != float64(201) {
		t.Fatalf("envelope = %v", body)
	}
	inner := body["body"].(map[string]any)
	if inner["base"] != "/tenant" {
		t.Errorf("handler saw path base %v", inner["base"])
	}
	headers := body["headers"].(map[string]any)
	for _, leaked := range []string{"set-cookie", "location", "content-length"} {
		if _, found := headers[leaked]; found {
			t.Errorf("leaked header %s", leaked)
		}
	}
	if headers["x-suppressed"] != "yes" {
		t.Errorf("effect was not suppressed in preview: %v", headers)
	}
	effects := body["effects"].([]any)
	if len(effects) != 1 || effects[0].(map[string]any)["kind"] != "email" {
		t.Errorf("effects = %v", effects)
	}
	if _, delivered := effects[0].(map[string]any)["delivered"]; delivered {
		t.Error("a preview effect must not claim delivery")
	}
	logs := body["logs"].([]any)
	if len(logs) != 1 || logs[0].(map[string]any)["message"] != "created:a" {
		t.Errorf("logs = %v", logs)
	}
	if h.provider.begun != 1 || h.provider.rolledBack != 1 || h.provider.closed != 1 {
		t.Errorf("lifecycle begun=%d rolledBack=%d closed=%d", h.provider.begun, h.provider.rolledBack, h.provider.closed)
	}
	if changes := body["changes"].([]any); len(changes) != 1 {
		t.Errorf("changes = %v", changes)
	}
}

func TestPathBaseIsEnforced(t *testing.T) {
	h := newHarness(t, "/tenant")
	if code := h.do("GET", "/bench/_api/capabilities", nil).Code; code != 404 {
		t.Errorf("outside the mount: %d", code)
	}
	if code := h.do("GET", "/tenantry/ready", nil).Code; code != 404 {
		t.Errorf("sibling prefix: %d", code)
	}
	redirect := h.do("GET", "/tenant/bench?from=x", nil)
	if redirect.Code != 302 || redirect.Header().Get("Location") != "/tenant/bench/?from=x" {
		t.Errorf("redirect %d %q", redirect.Code, redirect.Header().Get("Location"))
	}
	capabilities := decode(t, h.do("GET", "/tenant/bench/_api/capabilities", nil))
	if capabilities["openApiUrl"] != "/tenant/openapi.json" || capabilities["identity"] != nil {
		t.Errorf("capabilities = %v", capabilities)
	}
	provider := capabilities["authProviders"].([]any)[0].(map[string]any)
	if provider["url"] != "/tenant/auth/sign-in" || provider["kind"] != "cookie" {
		t.Errorf("provider = %v", provider)
	}
	signedIn := decode(t, h.do("GET", "/tenant/bench/_api/capabilities", map[string]string{"Cookie": "who=ada"}))
	if signedIn["identity"].(map[string]any)["name"] != "ADA" {
		t.Errorf("identity = %v", signedIn["identity"])
	}
}

func TestCapabilitiesAdvertiseOnlyMarkedOperations(t *testing.T) {
	h := newHarness(t, "")
	capabilities := decode(t, h.do("GET", "/bench/_api/capabilities", nil))
	if capabilities["observedSend"] != true || capabilities["database"] != "fixture" {
		t.Fatalf("capabilities = %v", capabilities)
	}
	var seen []string
	for _, entry := range capabilities["previewOperations"].([]any) {
		operation := entry.(map[string]any)
		seen = append(seen, operation["method"].(string)+" "+operation["path"].(string))
	}
	want := "POST /boom,POST /flood,POST /items/{id},POST /large"
	if strings.Join(seen, ",") != want {
		t.Errorf("operations = %v, want %s", seen, want)
	}
}

func TestPreviewRejectsInvalidTransport(t *testing.T) {
	h := newHarness(t, "")
	cases := []struct {
		name    string
		method  string
		path    string
		headers map[string]string
		want    int
	}{
		{"no preference", "POST", "/bench/_preview/items/a", map[string]string{"Cookie": "who=ada"}, 400},
		{"quoted preference", "POST", "/bench/_preview/items/a", map[string]string{"Prefer": `tx="rollback"`}, 400},
		{"combined preference", "POST", "/bench/_preview/items/a", map[string]string{"Prefer": "trace, tx=rollback"}, 400},
		{"rollback on a real URL", "POST", "/items/a", rollback, 400},
		{"head", "HEAD", "/bench/_preview/items/a", rollback, 405},
		{"double slash", "POST", "/bench/_preview//items/a", rollback, 400},
		{"workbench target", "POST", "/bench/_preview/bench/_api/capabilities", rollback, 400},
		{"dot segment", "POST", "/bench/_preview/items/../ordinary/a", rollback, 400},
		{"cross origin", "POST", "/bench/_preview/items/a", merge(rollback, "Origin", "https://elsewhere.example.test"), 403},
		{"cross site", "POST", "/bench/_preview/items/a", merge(rollback, "Sec-Fetch-Site", "cross-site"), 403},
		{"unmarked route", "POST", "/bench/_preview/ordinary/a", rollback, 409},
		{"unknown route", "POST", "/bench/_preview/missing", rollback, 409},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			response := h.do(tc.method, tc.path, tc.headers)
			if response.Code != tc.want {
				t.Fatalf("status %d, want %d: %s", response.Code, tc.want, response.Body)
			}
			if response.Header().Get("Preference-Applied") != "" || strings.Contains(response.Body.String(), "rolledBack") {
				t.Errorf("unconfirmed result looked confirmed: %s", response.Body)
			}
		})
	}
	if h.count("marked") != 0 || h.count("unmarked") != 0 || h.provider.begun != 0 {
		t.Errorf("a rejected preview executed: marked=%d unmarked=%d begun=%d", h.count("marked"), h.count("unmarked"), h.provider.begun)
	}
}

func merge(headers map[string]string, name, value string) map[string]string {
	merged := map[string]string{name: value}
	for key, existing := range headers {
		merged[key] = existing
	}
	return merged
}

func TestFailuresWithholdConfirmationButStillRollBack(t *testing.T) {
	t.Run("panic", func(t *testing.T) {
		h := newHarness(t, "")
		response := h.do("POST", "/bench/_preview/boom", rollback)
		if response.Code != 500 || strings.Contains(response.Body.String(), "rolledBack") {
			t.Fatalf("status %d: %s", response.Code, response.Body)
		}
		if h.provider.rolledBack != 1 || h.provider.closed != 1 {
			t.Errorf("rolledBack=%d closed=%d", h.provider.rolledBack, h.provider.closed)
		}
	})
	t.Run("rollback failure", func(t *testing.T) {
		h := newHarness(t, "")
		h.provider.rollbackErr = errors.New("injected")
		response := h.do("POST", "/bench/_preview/items/a", rollback)
		if response.Code != 500 || strings.Contains(response.Body.String(), "rolledBack") {
			t.Fatalf("status %d: %s", response.Code, response.Body)
		}
		if h.provider.closed != 1 {
			t.Error("the session was not closed after a failed rollback")
		}
	})
	t.Run("oversized response", func(t *testing.T) {
		h := newHarness(t, "")
		response := h.do("POST", "/bench/_preview/large", rollback)
		if response.Code != 413 || h.provider.rolledBack != 1 {
			t.Fatalf("status %d rolledBack=%d", response.Code, h.provider.rolledBack)
		}
	})
}

func TestCaptureLimitsAreReported(t *testing.T) {
	h := newHarness(t, "")
	body := decode(t, h.do("POST", "/bench/_preview/flood", rollback))
	for name, limit := range map[string]int{"logs": testbench.MaxLogs, "effects": testbench.MaxEffects} {
		if got := len(body[name].([]any)); got != limit {
			t.Errorf("%s retained %d, want %d", name, got, limit)
		}
		if body[name+"Truncated"] != true {
			t.Errorf("%sTruncated missing", name)
		}
	}
}

func TestDisabledEnvironmentExposesNothing(t *testing.T) {
	h := newHarness(t, "", testbench.WithEnvironment("Production"))
	if code := h.do("GET", "/bench/_api/capabilities", nil).Code; code != 404 {
		t.Errorf("capabilities: %d", code)
	}
	if code := h.do("GET", "/bench/", nil).Code; code != 404 {
		t.Errorf("index: %d", code)
	}
	if code := h.do("POST", "/bench/_preview/items/a", rollback).Code; code != 404 {
		t.Errorf("preview: %d", code)
	}
	if code := h.do("GET", "/ready", nil).Code; code != 200 {
		t.Errorf("ordinary route: %d", code)
	}
}

func TestNoProviderOffersNoPreview(t *testing.T) {
	bench, _ := testbench.New(testbench.WithEnvironment("Development"))
	mux := http.NewServeMux()
	bench.HandlePreview(mux, "POST /items", http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	handler := bench.Middleware(mux)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("GET", "/bench/_api/capabilities", nil))
	var capabilities map[string]any
	_ = json.Unmarshal(response.Body.Bytes(), &capabilities)
	if operations := capabilities["previewOperations"].([]any); len(operations) != 0 || capabilities["observedSend"] != false {
		t.Errorf("capabilities = %v", capabilities)
	}
	request := httptest.NewRequest("POST", "/bench/_preview/items", nil)
	request.Header.Set("Prefer", "tx=rollback")
	preview := httptest.NewRecorder()
	handler.ServeHTTP(preview, request)
	if preview.Code != 503 {
		t.Errorf("preview status %d", preview.Code)
	}
}

func TestAccessPolicyGuardsTheWorkbench(t *testing.T) {
	h := newHarness(t, "", testbench.WithAccessPolicy(func(r *http.Request) bool {
		cookie, err := r.Cookie("who")
		return err == nil && cookie.Value == "ada"
	}))
	if code := h.do("GET", "/bench/_api/capabilities", nil).Code; code != 401 {
		t.Errorf("anonymous: %d", code)
	}
	if code := h.do("GET", "/bench/_api/capabilities", map[string]string{"Cookie": "who=bob"}).Code; code != 403 {
		t.Errorf("forbidden: %d", code)
	}
	if code := h.do("POST", "/bench/_preview/items/a", map[string]string{"Prefer": "tx=rollback", "Cookie": "who=bob"}).Code; code != 403 {
		t.Errorf("preview: %d", code)
	}
	if code := h.do("GET", "/bench/_api/capabilities", map[string]string{"Cookie": "who=ada"}).Code; code != 200 {
		t.Errorf("allowed: %d", code)
	}
}

func TestEmbeddedUIIsServed(t *testing.T) {
	h := newHarness(t, "/tenant")
	index := h.do("GET", "/tenant/bench/", nil)
	if index.Code != 200 || !strings.Contains(index.Body.String(), "Test Bench") || index.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("index: %d %v", index.Code, index.Header())
	}
	if !strings.Contains(index.Header().Get("Cache-Control"), "no-cache") {
		t.Errorf("cache-control = %q", index.Header().Get("Cache-Control"))
	}
	if code := h.do("GET", "/tenant/bench/missing.js", nil).Code; code != 404 {
		t.Errorf("missing asset: %d", code)
	}
	if version, hash := testbench.UIVersion(); version == "" || len(hash) != 64 {
		t.Errorf("UI manifest = %q %q", version, hash)
	}
}

func TestObservedSendTraceBelongsToItsOwner(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	var mu sync.Mutex
	clock := func() time.Time { mu.Lock(); defer mu.Unlock(); return now }
	h := newHarness(t, "/tenant", testbench.WithTraceTTL(5*time.Second), testbench.WithClock(clock))
	send := map[string]string{"Prefer": "trace", "Cookie": "who=ada"}

	anonymous := h.do("POST", "/tenant/items/x", map[string]string{"Prefer": "trace"})
	if anonymous.Header().Get("X-TestBench-Trace") != "" {
		t.Error("an anonymous send must not be traced")
	}
	foreign := h.do("POST", "/tenant/items/x", merge(send, "Origin", "https://elsewhere.example.test"))
	if foreign.Code != 201 || foreign.Header().Get("X-TestBench-Trace") != "" {
		t.Error("a cross-origin send must run untraced")
	}
	if code := h.do("POST", "/tenant/ordinary/x", send).Header().Get("X-TestBench-Trace"); code != "" {
		t.Error("an unmarked route must not be traced")
	}

	sent := h.do("POST", "/tenant/items/traced", send)
	id := sent.Header().Get("X-TestBench-Trace")
	if sent.Code != 201 || len(id) != 32 || !strings.Contains(sent.Header().Get("Server-Timing"), "db;dur=") {
		t.Fatalf("sent %d trace=%q headers=%v", sent.Code, id, sent.Header())
	}
	if h.provider.begun != 0 || h.provider.rolledBack != 0 {
		t.Error("an observed send must not open a rollback session")
	}
	path := "/tenant/bench/_api/traces/" + id
	owned := h.do("GET", path, map[string]string{"Cookie": "who=ada"})
	if owned.Code != 200 || owned.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("owner read: %d %v", owned.Code, owned.Header())
	}
	trace := decode(t, owned)
	logs := trace["logs"].([]any)
	if len(logs) != 1 || !strings.Contains(logs[0].(map[string]any)["message"].(string), "created:traced") {
		t.Errorf("logs = %v", logs)
	}
	if effect := trace["effects"].([]any)[0].(map[string]any); effect["delivered"] != true {
		t.Errorf("effect = %v", effect)
	}
	if len(trace["changes"].([]any)) != 1 || trace["timing"].(map[string]any)["queryCount"] == nil {
		t.Errorf("trace = %v", trace)
	}
	if code := h.do("GET", path, map[string]string{"Cookie": "who=bob"}).Code; code != 404 {
		t.Errorf("foreign read: %d", code)
	}
	if code := h.do("GET", path, nil).Code; code != 404 {
		t.Errorf("anonymous read: %d", code)
	}
	mu.Lock()
	now = now.Add(5 * time.Second)
	mu.Unlock()
	if code := h.do("GET", path, map[string]string{"Cookie": "who=ada"}).Code; code != 404 {
		t.Errorf("expired read: %d", code)
	}
}

func TestIsSecretName(t *testing.T) {
	secret := []string{"fixture_secret", "PasswordHash", "api_key", "RefreshToken", "client key", "@auth_token", "salt"}
	plain := []string{"IdempotencyKey", "Monkey", "id", "name", "primary_key", "tokens_issued_at_" + "x" + "yz"}
	for _, name := range secret {
		if !testbench.IsSecretName(name) {
			t.Errorf("%q should be secret", name)
		}
	}
	for _, name := range plain[:5] {
		if testbench.IsSecretName(name) {
			t.Errorf("%q should be visible", name)
		}
	}
}
