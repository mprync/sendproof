package cassandrabench_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	gocql "github.com/apache/cassandra-gocql-driver/v2"

	"github.com/mprync/sendproof/adapters/go/cassandrabench"
	"github.com/mprync/sendproof/adapters/go/sendproof"
)

// contactPoint is the compose service
// (docker compose -f tests/conformance/compose.yml --profile heavy-stores up -d --wait cassandra).
func contactPoint() (host string, port int) {
	address := os.Getenv("BENCH_CASSANDRA_SERVER")
	if address == "" {
		address = "127.0.0.1:59042"
	}
	host, rawPort, _ := strings.Cut(address, ":")
	port, err := strconv.Atoi(rawPort)
	if err != nil {
		port = 9042
	}
	return host, port
}

func clusterConfig(keyspace string) *gocql.ClusterConfig {
	host, port := contactPoint()
	cluster := gocql.NewCluster(host)
	cluster.Port = port
	cluster.Keyspace = keyspace
	cluster.Consistency = gocql.One
	cluster.Timeout = 10 * time.Second
	cluster.ConnectTimeout = 5 * time.Second
	cluster.DisableInitialHostLookup = true
	return cluster
}

// newKeyspace creates a fresh keyspace with table tickets through an unguarded
// session (test setup, and the independent reader for assertions) and drops it afterwards.
// The test skips with the compose command when Cassandra does not answer.
func newKeyspace(t *testing.T) (keyspace string, plain *gocql.Session) {
	t.Helper()
	random := make([]byte, 4)
	_, _ = rand.Read(random)
	keyspace = "tb_" + hex.EncodeToString(random)
	admin, err := clusterConfig("").CreateSession()
	if err != nil {
		t.Skipf("Cassandra is not reachable (docker compose -f tests/conformance/compose.yml --profile heavy-stores up -d --wait cassandra): %v", err)
	}
	for _, statement := range []string{
		"CREATE KEYSPACE " + keyspace + " WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}",
		"CREATE TABLE " + keyspace + ".tickets (id text PRIMARY KEY, status text, hits int)",
	} {
		if err := admin.Query(statement).Exec(); err != nil {
			admin.Close()
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		_ = admin.Query("DROP KEYSPACE " + keyspace).Exec()
		admin.Close()
	})
	plain, err = clusterConfig(keyspace).CreateSession()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(plain.Close)
	return keyspace, plain
}

// app is a bench whose handlers use the guarded session.
type app struct {
	handler http.Handler
	plain   *gocql.Session
}

// newApp builds the app. guarded=false gives handlers a raw session, to prove the
// checks fail without the guard.
func newApp(t *testing.T, guarded bool) *app {
	t.Helper()
	keyspace, plain := newKeyspace(t)
	bench, err := sendproof.New(
		sendproof.WithEnvironment("Development"), sendproof.WithDataStore(cassandrabench.Store("tickets")),
		sendproof.WithPrincipal(func(*http.Request) (sendproof.Principal, bool) {
			return sendproof.Principal{Subject: "ada", Name: "Ada", Scheme: "cookie"}, true
		}),
	)
	if err != nil {
		t.Fatal(err)
	}
	// session runs a statement the way a handler would: through the wrapper, or the raw session.
	var guard *cassandrabench.Session
	if guarded {
		guard, err = cassandrabench.Connect(clusterConfig(keyspace))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(guard.Close)
	}
	exec := func(ctx context.Context, statement string, values ...any) error {
		if guard != nil {
			return guard.Query(statement, values...).WithContext(ctx).Exec()
		}
		return plain.Query(statement, values...).WithContext(ctx).Exec()
	}
	reply := func(w http.ResponseWriter, status int, body any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
	}
	mux := http.NewServeMux()
	bench.HandlePreview(mux, "GET /tickets/{id}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var id, status string
		var hits int
		query := `SELECT id, status, hits FROM tickets WHERE id = ?`
		var err error
		if guard != nil {
			err = guard.Query(query, r.PathValue("id")).WithContext(r.Context()).Scan(&id, &status, &hits)
		} else {
			err = plain.Query(query, r.PathValue("id")).WithContext(r.Context()).Scan(&id, &status, &hits)
		}
		if errors.Is(err, gocql.ErrNotFound) {
			reply(w, 404, map[string]any{"error": "not found"})
			return
		}
		if err != nil {
			reply(w, 500, map[string]any{"error": err.Error()})
			return
		}
		reply(w, 200, map[string]any{"id": id, "status": status, "hits": hits})
	}))
	// Each write route swallows the error and answers 200: the Preview must still answer 409.
	write := func(statement string, values func(r *http.Request) []any) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if err := exec(r.Context(), statement, values(r)...); err != nil {
				reply(w, 200, map[string]any{"swallowed": err.Error()})
				return
			}
			reply(w, 200, map[string]any{})
		}
	}
	id := func(r *http.Request) []any { return []any{r.PathValue("id")} }
	bench.HandlePreview(mux, "POST /tickets/{id}/touch", write(`INSERT INTO tickets (id, status, hits) VALUES (?, 'new', 1)`, id))
	bench.HandlePreview(mux, "POST /tickets/{id}/lwt", write(`INSERT INTO tickets (id, status) VALUES (?, 'new') IF NOT EXISTS`, id))
	bench.HandlePreview(mux, "POST /tickets/{id}/update", write(`UPDATE tickets SET status = 'closed' WHERE id = ?`, id))
	bench.HandlePreview(mux, "POST /tickets/{id}/delete", write(`DELETE FROM tickets WHERE id = ?`, id))
	bench.HandlePreview(mux, "POST /truncate", write(`TRUNCATE tickets`, func(*http.Request) []any { return nil }))
	bench.HandlePreview(mux, "POST /ddl", write(`CREATE TABLE extra (id text PRIMARY KEY)`, func(*http.Request) []any { return nil }))
	bench.HandlePreview(mux, "POST /two", write(`SELECT * FROM tickets; DELETE FROM tickets WHERE id = 'x'`, func(*http.Request) []any { return nil }))
	bench.HandlePreview(mux, "POST /tickets/{id}/close", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if guard == nil {
			batch := plain.Batch(gocql.LoggedBatch).WithContext(r.Context())
			batch.Query(`UPDATE tickets SET status = 'closed' WHERE id = ? IF EXISTS`, r.PathValue("id"))
			if err := batch.Exec(); err != nil {
				reply(w, 200, map[string]any{"swallowed": err.Error()})
				return
			}
			reply(w, 200, map[string]any{})
			return
		}
		batch := guard.Batch(gocql.LoggedBatch).WithContext(r.Context())
		batch.Query(`UPDATE tickets SET status = 'closed' WHERE id = ? IF EXISTS`, r.PathValue("id"))
		if err := guard.ExecuteBatch(batch); err != nil {
			reply(w, 200, map[string]any{"swallowed": err.Error()})
			return
		}
		reply(w, 200, map[string]any{})
	}))
	// derived exercises every way a handler can derive a query: all stay guarded.
	bench.HandlePreview(mux, "POST /derived/{id}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if guard == nil {
			return
		}
		query := guard.Query(`INSERT INTO tickets (id) VALUES (?)`).Consistency(gocql.One).PageSize(10).Idempotent(true)
		derived := query.WithContext(r.Context()).Bind(r.PathValue("id"))
		errs := []string{derived.Exec().Error()}
		iter := derived.Iter()
		errs = append(errs, iter.Close().Error(), iter.Scanner().Err().Error())
		reply(w, 200, map[string]any{"errors": errs})
	}))
	// background writes with no request context.
	bench.HandlePreview(mux, "POST /background/{id}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if guard != nil {
			_ = guard.Query(`INSERT INTO tickets (id, status) VALUES (?, 'bg')`, r.PathValue("id")).Exec()
		}
		w.WriteHeader(200)
	}))
	return &app{handler: bench.Middleware(mux), plain: plain}
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

// status reads a ticket's status through the unguarded session; "" when there is no row.
func (a *app) status(t *testing.T, id string) string {
	t.Helper()
	var status string
	err := a.plain.Query(`SELECT status FROM tickets WHERE id = ?`, id).Scan(&status)
	if err != nil && !errors.Is(err, gocql.ErrNotFound) {
		t.Fatal(err)
	}
	return status
}

func (a *app) seed(t *testing.T, id, status string) {
	t.Helper()
	if err := a.plain.Query(`INSERT INTO tickets (id, status, hits) VALUES (?, ?, 0)`, id, status).Exec(); err != nil {
		t.Fatal(err)
	}
}

func assertBlocked(t *testing.T, response *httptest.ResponseRecorder, operation string) {
	t.Helper()
	var body map[string]any
	_ = json.Unmarshal(response.Body.Bytes(), &body)
	if response.Code != 409 || body["code"] != "preview_unavailable" || body["store"] != "cassandra" || body["operation"] != operation ||
		body["detail"] != "Preview unavailable: this operation writes to Cassandra" || body["rolledBack"] != false ||
		response.Header().Get("Preference-Applied") != "" {
		t.Fatalf("expected a blocked Preview for %s, got %d %s", operation, response.Code, response.Body)
	}
}

func TestReadsRunInPreviewAndAreLogged(t *testing.T) {
	a := newApp(t, true)
	a.seed(t, "t1", "open")
	response := a.preview("GET", "/tickets/t1")
	var body map[string]any
	_ = json.Unmarshal(response.Body.Bytes(), &body)
	if inner, _ := body["body"].(map[string]any); response.Code != 200 || body["rolledBack"] != true || inner["status"] != "open" {
		t.Fatalf("a read must be confirmed: %d %s", response.Code, response.Body)
	}
	logs, _ := body["logs"].([]any)
	if len(logs) != 1 {
		t.Fatalf("want one Db entry: %v", logs)
	}
	entry := logs[0].(map[string]any)["db"].(map[string]any)
	if entry["system"] != "cassandra" || entry["operation"] != "SELECT" || entry["target"] != "tickets" ||
		entry["statement"] != "SELECT id, status, hits FROM tickets WHERE id = ?" {
		t.Errorf("Db entry: %v", entry)
	}
	if entry["namespace"] == "" {
		t.Errorf("the keyspace is the namespace: %v", entry)
	}
}

func TestWritesAreRefusedBeforeTheyAreSent(t *testing.T) {
	a := newApp(t, true)
	a.seed(t, "t1", "open")
	cases := []struct{ route, operation string }{
		{"/tickets/t2/touch", "INSERT"}, {"/tickets/t3/lwt", "INSERT"}, {"/tickets/t1/update", "UPDATE"}, {"/tickets/t1/delete", "DELETE"},
		{"/tickets/t1/close", "BATCH"}, {"/truncate", "TRUNCATE"}, {"/ddl", "CREATE"}, {"/two", "SELECT"},
	}
	for _, c := range cases {
		assertBlocked(t, a.preview("POST", c.route), c.operation)
	}
	if got := a.status(t, "t1"); got != "open" {
		t.Errorf("a refused write reached Cassandra: t1 is %q", got)
	}
	for _, id := range []string{"t2", "t3"} {
		if a.status(t, id) != "" {
			t.Errorf("a refused INSERT reached Cassandra: %s", id)
		}
	}
	if err := a.plain.Query(`SELECT id FROM extra`).Exec(); err == nil {
		t.Error("a refused CREATE TABLE reached Cassandra")
	}
}

func TestDerivedQueriesStayGuarded(t *testing.T) {
	a := newApp(t, true)
	assertBlocked(t, a.preview("POST", "/derived/d1"), "INSERT")
	if a.status(t, "d1") != "" {
		t.Error("a derived query wrote")
	}
}

func TestTheChecksFailWithoutTheGuard(t *testing.T) {
	a := newApp(t, false)
	response := a.preview("POST", "/tickets/t2/touch")
	if response.Code != 200 || a.status(t, "t2") != "new" {
		t.Fatalf("an unguarded session should have written: %d", response.Code)
	}
}

func TestSendIsNeverBlockedAndObservedSendTracesTheStatement(t *testing.T) {
	a := newApp(t, true)
	response := a.do("POST", "/tickets/sent/touch", map[string]string{"Prefer": "trace"})
	id := response.Header().Get("X-Sendproof-Trace")
	if response.Code != 200 || id == "" || a.status(t, "sent") != "new" {
		t.Fatalf("observed send: %d %v", response.Code, response.Header())
	}
	trace := a.do("GET", "/sendproof/_api/traces/"+id, nil).Body.String()
	if !strings.Contains(trace, `"operation":"INSERT"`) || !strings.Contains(trace, `VALUES (?, ?, ?)`) || strings.Contains(trace, "'new'") {
		t.Errorf("trace must hold the statement with every literal replaced: %s", trace)
	}
	if plain := a.do("POST", "/tickets/sent2/touch", nil); plain.Code != 200 || a.status(t, "sent2") != "new" {
		t.Errorf("an ordinary Send was blocked: %d", plain.Code)
	}
}

func TestAWriteWithoutTheRequestContextNeverConfirms(t *testing.T) {
	a := newApp(t, true)
	response := a.preview("POST", "/background/b1")
	if response.Code != 500 || response.Header().Get("Preference-Applied") != "" {
		t.Fatalf("want 500 without confirmation, got %d %s", response.Code, response.Body)
	}
	if a.status(t, "b1") != "bg" {
		t.Error("the unattributed write should have run (it is reported, not blocked)")
	}
}

func TestCapabilitiesListTheStoreInGuardMode(t *testing.T) {
	bench, err := sendproof.New(sendproof.WithEnvironment("Development"), sendproof.WithDataStore(cassandrabench.Store("tickets")))
	if err != nil {
		t.Fatal(err)
	}
	var body struct {
		DataStores []sendproof.DataStoreInfo `json:"dataStores"`
	}
	response := httptest.NewRecorder()
	bench.Middleware(http.NewServeMux()).ServeHTTP(response, httptest.NewRequest("GET", "/sendproof/_api/capabilities", nil))
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || len(body.DataStores) != 1 ||
		body.DataStores[0] != (sendproof.DataStoreInfo{System: "cassandra", Name: "tickets", Mode: "guard"}) {
		t.Errorf("dataStores: %+v %v", body.DataStores, err)
	}
}

func TestStoreRefusesAConnectionStringAsALabel(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Error("a host:port must not be accepted as a store name")
		}
	}()
	cassandrabench.Store("cassandra:9042")
}
