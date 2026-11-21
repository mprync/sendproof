package mongobench_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mprync/sendproof/adapters/go/mongobench"
	"github.com/mprync/sendproof/adapters/go/sendproof"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

func serverURL() string {
	if url := os.Getenv("BENCH_MONGODB_SERVER_URL"); url != "" {
		return url
	}
	return "mongodb://127.0.0.1:57017/?directConnection=true"
}

// connect opens a client, with the store's monitor when store is not nil, and
// skips the test with the compose command when the server does not answer.
func connect(t *testing.T, store *mongobench.Store) *mongo.Client {
	t.Helper()
	opts := options.Client().ApplyURI(serverURL()).SetServerSelectionTimeout(2 * time.Second)
	if store != nil {
		opts = store.ClientOptions(opts)
	}
	client, err := mongo.Connect(opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Disconnect(context.Background()) })
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := client.Ping(ctx, nil); err != nil {
		t.Skipf("MongoDB is not reachable (docker compose -f tests/conformance/compose.yml up -d mongodb): %v", err)
	}
	return client
}

// app is a bench whose handlers use the guarded collection.
type app struct {
	handler http.Handler
	store   *mongobench.Store
	plain   *mongo.Collection // an unhooked client's view of the same collection
	raw     *mongo.Collection // the hooked client's raw collection, which the guard does not cover
	docs    *mongobench.Collection
	gate    chan struct{}
	bench   *sendproof.Sendproof
	entered chan struct{}
}

type appOptions struct {
	store   []mongobench.Option
	monitor bool // false builds the client without the store's monitor
	guard   bool // simulate a standalone server
}

func newApp(t *testing.T, o appOptions) *app {
	t.Helper()
	store := mongobench.New(append([]mongobench.Option{mongobench.WithName("catalog")}, o.store...)...)
	if o.guard {
		mongobench.ForceGuardMode(store)
	}
	var hooked *mongo.Client
	if o.monitor {
		hooked = connect(t, store)
	} else {
		hooked = connect(t, nil)
	}
	plainClient := connect(t, nil)
	random := make([]byte, 4)
	_, _ = rand.Read(random)
	database := "tb_" + hex.EncodeToString(random)
	t.Cleanup(func() { _ = plainClient.Database(database).Drop(context.Background()) })
	a := &app{store: store, gate: make(chan struct{}), entered: make(chan struct{}, 4)}
	a.plain = plainClient.Database(database).Collection("documents")
	a.raw = hooked.Database(database).Collection("documents")
	a.docs = store.Database(hooked.Database(database)).Collection("documents")

	bench, err := sendproof.New(
		sendproof.WithEnvironment("Development"), sendproof.WithDataStore(store),
		sendproof.WithPrincipal(func(*http.Request) (sendproof.Principal, bool) {
			return sendproof.Principal{Subject: "ada", Name: "Ada", Scheme: "cookie"}, true
		}),
	)
	if err != nil {
		t.Fatal(err)
	}
	a.bench = bench
	reply := func(w http.ResponseWriter, status int, body any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
	}
	fail := func(w http.ResponseWriter, err error) { reply(w, 500, map[string]any{"error": err.Error()}) }
	type document struct {
		ID           string         `bson:"_id" json:"id"`
		Name         string         `bson:"name" json:"name"`
		Profile      map[string]any `bson:"profile" json:"profile"`
		PasswordHash string         `bson:"password_hash,omitempty" json:"-"`
	}
	mux := http.NewServeMux()
	bench.HandlePreview(mux, "GET /documents/{id}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var found document
		if err := a.docs.FindOne(r.Context(), bson.D{{Key: "_id", Value: r.PathValue("id")}}).Decode(&found); err != nil {
			reply(w, 404, map[string]any{"error": err.Error()})
			return
		}
		reply(w, 200, found)
	}))
	bench.HandlePreview(mux, "POST /documents", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in struct{ ID, Name, City, Password string }
		_ = json.NewDecoder(r.Body).Decode(&in)
		sendproof.Log(r.Context(), "Information", "created-document:"+in.ID)
		_, err := a.docs.InsertOne(r.Context(), document{ID: in.ID, Name: in.Name, Profile: map[string]any{"city": in.City}, PasswordHash: "hashed:" + in.Password})
		if err != nil {
			fail(w, err)
			return
		}
		reply(w, 201, map[string]any{"id": in.ID})
	}))
	bench.HandlePreview(mux, "PATCH /documents/{id}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in struct{ Name, City string }
		_ = json.NewDecoder(r.Body).Decode(&in)
		set := bson.D{}
		if in.Name != "" {
			set = append(set, bson.E{Key: "name", Value: in.Name})
		}
		if in.City != "" {
			set = append(set, bson.E{Key: "profile.city", Value: in.City})
		}
		result, err := a.docs.UpdateOne(r.Context(), bson.D{{Key: "_id", Value: r.PathValue("id")}}, bson.D{{Key: "$set", Value: set}})
		if err != nil {
			fail(w, err)
			return
		}
		if result.MatchedCount == 0 {
			reply(w, 404, nil)
			return
		}
		reply(w, 200, map[string]any{"id": r.PathValue("id")})
	}))
	// archive runs $out inside a $facet-free pipeline; the handler swallows the refusal.
	bench.HandlePreview(mux, "POST /documents/archive", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, err := a.docs.Aggregate(r.Context(), bson.A{bson.D{{Key: "$match", Value: bson.D{}}}, bson.D{{Key: "$out", Value: "documents_archive"}}})
		if err != nil {
			reply(w, 200, map[string]any{"swallowed": err.Error()})
			return
		}
		w.WriteHeader(204)
	}))
	// nested hides $merge in a $facet sub-pipeline.
	bench.HandlePreview(mux, "POST /documents/nested", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, err := a.docs.Aggregate(r.Context(), []bson.D{{{Key: "$facet", Value: bson.D{{Key: "x", Value: bson.A{bson.D{{Key: "$merge", Value: "documents_archive"}}}}}}}})
		if err != nil {
			reply(w, 200, map[string]any{"swallowed": err.Error()})
			return
		}
		w.WriteHeader(204)
	}))
	bench.HandlePreview(mux, "POST /documents/create", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = a.docs.Name()
		err := store.Database(hookedDatabase(hooked, database)).CreateCollection(r.Context(), "explicit")
		reply(w, 200, map[string]any{"swallowed": err != nil})
	}))
	// touch updates every document: the snapshot decides which ones count.
	bench.HandlePreview(mux, "POST /documents/touch-all", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var first document
		_ = a.docs.FindOne(r.Context(), bson.D{{Key: "_id", Value: "seeded"}}).Decode(&first) // starts the transaction
		if err := a.plain.Database().Collection("documents").FindOne(context.Background(), bson.D{}).Err(); err != nil {
			_ = err
		}
		// Another request commits a new document after the transaction's snapshot.
		_, _ = a.plain.InsertOne(context.Background(), bson.D{{Key: "_id", Value: "concurrent"}, {Key: "name", Value: "Late"}})
		if _, err := a.docs.UpdateMany(r.Context(), bson.D{}, bson.D{{Key: "$set", Value: bson.D{{Key: "touched", Value: true}}}}); err != nil {
			fail(w, err)
			return
		}
		w.WriteHeader(204)
	}))
	// escape writes through the raw collection with the request's context: no session.
	bench.HandlePreview(mux, "POST /escape/raw", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, err := a.raw.InsertOne(r.Context(), bson.D{{Key: "_id", Value: "escaped"}, {Key: "name", Value: "Raw"}})
		reply(w, 200, map[string]any{"swallowed": err != nil})
	}))
	// escape/background writes through the guarded collection without the request's
	// context: the wrapper can't see the Preview, so only the monitor can stop a confirmation.
	bench.HandlePreview(mux, "POST /escape/background", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, err := a.docs.InsertOne(context.Background(), bson.D{{Key: "_id", Value: "background"}})
		reply(w, 200, map[string]any{"swallowed": err != nil})
	}))
	bench.HandlePreview(mux, "POST /escape/foreign", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		session, err := hooked.StartSession()
		if err != nil {
			fail(w, err)
			return
		}
		defer session.EndSession(context.Background())
		_, err = a.docs.InsertOne(mongo.NewSessionContext(r.Context(), session), bson.D{{Key: "_id", Value: "foreign"}})
		reply(w, 200, map[string]any{"swallowed": err != nil})
	}))
	bench.HandlePreview(mux, "POST /escape/commit", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = a.docs.InsertOne(r.Context(), bson.D{{Key: "_id", Value: "committed"}})
		err := store.Database(hookedDatabase(hooked, database)).RunCommand(r.Context(), bson.D{{Key: "commitTransaction", Value: 1}}).Err()
		reply(w, 200, map[string]any{"swallowed": err != nil})
	}))
	// rawcommit sends commitTransaction around the guard: the monitor must trip.
	bench.HandlePreview(mux, "POST /escape/rawcommit", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = a.docs.InsertOne(r.Context(), bson.D{{Key: "_id", Value: "raw-committed"}})
		err := hooked.Database(database).RunCommand(r.Context(), bson.D{{Key: "commitTransaction", Value: 1}}).Err()
		reply(w, 200, map[string]any{"swallowed": err != nil})
	}))
	bench.HandlePreview(mux, "POST /session/commit", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		session, _ := store.Client(hooked).StartSession(r.Context())
		_, _ = a.docs.InsertOne(r.Context(), bson.D{{Key: "_id", Value: "session-commit"}})
		err := session.CommitTransaction(r.Context())
		reply(w, 200, map[string]any{"swallowed": err != nil})
	}))
	bench.HandlePreview(mux, "POST /session/with", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		session, err := store.Client(hooked).StartSession(r.Context())
		if err != nil {
			fail(w, err)
			return
		}
		defer session.EndSession(r.Context())
		_, err = session.WithTransaction(r.Context(), func(ctx context.Context) (any, error) {
			return a.docs.InsertOne(ctx, bson.D{{Key: "_id", Value: "joined"}, {Key: "name", Value: "Joined"}})
		})
		if err != nil {
			fail(w, err)
			return
		}
		w.WriteHeader(201)
	}))
	// session/reach takes the driver session out of the joined context and commits
	// it: the Preview's transaction must never be reachable that way.
	bench.HandlePreview(mux, "POST /session/reach", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		commit := func(ctx context.Context) error {
			if _, err := a.docs.InsertOne(ctx, bson.D{{Key: "_id", Value: "reached"}}); err != nil {
				return err
			}
			if session := mongo.SessionFromContext(ctx); session != nil {
				return session.CommitTransaction(ctx)
			}
			return nil
		}
		client := store.Client(hooked)
		if r.URL.Query().Get("via") == "use" {
			_ = client.UseSession(r.Context(), commit)
		} else {
			session, _ := client.StartSession(r.Context())
			_, _ = session.WithTransaction(r.Context(), func(ctx context.Context) (any, error) { return nil, commit(ctx) })
		}
		w.WriteHeader(201)
	}))
	// slow updates a document, then waits for the gate: a second Preview of the same document conflicts.
	bench.HandlePreview(mux, "PATCH /slow/{id}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, err := a.docs.UpdateOne(r.Context(), bson.D{{Key: "_id", Value: r.PathValue("id")}}, bson.D{{Key: "$set", Value: bson.D{{Key: "name", Value: "slow"}}}})
		if err != nil {
			reply(w, 409, map[string]any{"error": err.Error()})
			return
		}
		a.entered <- struct{}{}
		select {
		case <-a.gate:
		case <-time.After(10 * time.Second):
		}
		w.WriteHeader(200)
	}))
	bench.HandlePreview(mux, "POST /sleep/{ms}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = a.docs.InsertOne(r.Context(), bson.D{{Key: "_id", Value: "sleepy"}})
		time.Sleep(700 * time.Millisecond)
		_, err := a.docs.InsertOne(r.Context(), bson.D{{Key: "_id", Value: "after-sleep"}})
		reply(w, 200, map[string]any{"swallowed": err != nil})
	}))
	// flip changes the detected mode in the middle of a guard-mode Preview.
	bench.HandlePreview(mux, "PATCH /flip/{id}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mongobench.ForcePreviewMode(store)
		_, err := a.docs.UpdateOne(r.Context(), bson.D{{Key: "_id", Value: r.PathValue("id")}}, bson.D{{Key: "$set", Value: bson.D{{Key: "name", Value: "flipped"}}}})
		reply(w, 200, map[string]any{"swallowed": err != nil})
	}))
	bench.HandleUnavailable(mux, "DELETE /documents/{id}", "", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, err := a.docs.DeleteOne(r.Context(), bson.D{{Key: "_id", Value: r.PathValue("id")}})
		if err != nil {
			fail(w, err)
			return
		}
		w.WriteHeader(204)
	}), sendproof.ForStores("mongodb"))
	a.handler = bench.Middleware(mux)
	return a
}

func hookedDatabase(client *mongo.Client, name string) *mongo.Database { return client.Database(name) }

func (a *app) do(method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response := httptest.NewRecorder()
	a.handler.ServeHTTP(response, request)
	return response
}

func (a *app) preview(method, target, body string) *httptest.ResponseRecorder {
	return a.do(method, "/sendproof/_preview"+target, body, map[string]string{"Prefer": "tx=rollback"})
}

func (a *app) seed(t *testing.T) {
	t.Helper()
	_, err := a.plain.InsertOne(context.Background(), bson.D{
		{Key: "_id", Value: "seeded"}, {Key: "name", Value: "Seeded"}, {Key: "profile", Value: bson.D{{Key: "city", Value: "Leeds"}}},
		{Key: "password_hash", Value: "hashed:seeded-secret"},
	})
	if err != nil {
		t.Fatal(err)
	}
}

func (a *app) count(t *testing.T, id string) int64 {
	t.Helper()
	count, err := a.plain.CountDocuments(context.Background(), bson.D{{Key: "_id", Value: id}})
	if err != nil {
		t.Fatal(err)
	}
	return count
}

func decodeBody(t *testing.T, response *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode %q: %v", response.Body.String(), err)
	}
	return body
}

func assertUnconfirmed(t *testing.T, response *httptest.ResponseRecorder, status int) {
	t.Helper()
	if response.Code != status || response.Header().Get("Preference-Applied") != "" || strings.Contains(response.Body.String(), `"rolledBack":true`) {
		t.Fatalf("expected an unconfirmed %d, got %d %v %s", status, response.Code, response.Header(), response.Body)
	}
}

func changesOf(t *testing.T, response *httptest.ResponseRecorder) []map[string]any {
	t.Helper()
	body := decodeBody(t, response)
	var changes []map[string]any
	for _, change := range body["changes"].([]any) {
		changes = append(changes, change.(map[string]any))
	}
	return changes
}

func TestPreviewRollsBackAndReportsNestedRedactedChanges(t *testing.T) {
	a := newApp(t, appOptions{monitor: true})
	a.seed(t)

	created := a.preview("POST", "/documents", `{"ID":"preview-doc","Name":"Draft","City":"York","Password":"mongo-secret-value"}`)
	if created.Code != 200 || created.Header().Get("Preference-Applied") != "tx=rollback" {
		t.Fatalf("create: %d %s", created.Code, created.Body)
	}
	changes := changesOf(t, created)
	if len(changes) != 1 || changes[0]["operation"] != "insert" || changes[0]["store"] != "mongodb" || changes[0]["table"] != "documents" ||
		changes[0]["before"] != nil {
		t.Fatalf("insert change: %v", changes)
	}
	if key := changes[0]["key"].(map[string]any); key["_id"] != "preview-doc" {
		t.Errorf("key: %v", key)
	}
	after := changes[0]["after"].(map[string]any)
	if after["profile"].(map[string]any)["city"] != "York" || after["password_hash"] != "[REDACTED]" {
		t.Errorf("after must keep nesting and redact secrets: %v", after)
	}
	if strings.Contains(created.Body.String(), "mongo-secret-value") {
		t.Error("a secret reached the envelope")
	}
	if a.count(t, "preview-doc") != 0 {
		t.Error("an independent read found the previewed insert")
	}
	logs := decodeBody(t, created)["logs"].([]any)
	var found bool
	for _, log := range logs {
		if db, ok := log.(map[string]any)["db"].(map[string]any); ok && db["operation"] == "insert" && db["target"] == "documents" && db["system"] == "mongodb" {
			found = true
			if strings.Contains(db["statement"].(string), "preview-doc") || !strings.Contains(db["statement"].(string), `"?"`) {
				t.Errorf("the statement must replace literals with ?: %v", db["statement"])
			}
		}
	}
	if !found {
		t.Errorf("no Db entry for the insert: %v", logs)
	}

	updated := a.preview("PATCH", "/documents/seeded", `{"Name":"Renamed","City":"Hull"}`)
	changes = changesOf(t, updated)
	if len(changes) != 1 || changes[0]["operation"] != "update" {
		t.Fatalf("update change: %v", changes)
	}
	before, now := changes[0]["before"].(map[string]any), changes[0]["after"].(map[string]any)
	if before["name"] != "Seeded" || now["name"] != "Renamed" ||
		before["profile"].(map[string]any)["city"] != "Leeds" || now["profile"].(map[string]any)["city"] != "Hull" {
		t.Errorf("before/after: %v / %v", before, now)
	}
	var stored bson.M
	if err := a.plain.FindOne(context.Background(), bson.D{{Key: "_id", Value: "seeded"}}).Decode(&stored); err != nil || stored["name"] != "Seeded" {
		t.Errorf("an independent read must find the seeded document unchanged: %v %v", stored, err)
	}
}

func TestExplicitCreateAndOutAreBlockedBeforeSending(t *testing.T) {
	a := newApp(t, appOptions{monitor: true})
	a.seed(t)
	for _, path := range []string{"/documents/archive", "/documents/nested"} {
		response := a.preview("POST", path, `{}`)
		body := decodeBody(t, response)
		if response.Code != 409 || body["code"] != "preview_unavailable" || body["store"] != "mongodb" || body["operation"] != "aggregate" ||
			!strings.Contains(body["detail"].(string), "$out") && !strings.Contains(body["detail"].(string), "$merge") {
			t.Fatalf("%s: %d %s", path, response.Code, response.Body)
		}
	}
	if names, _ := a.plain.Database().ListCollectionNames(context.Background(), bson.D{{Key: "name", Value: "documents_archive"}}); len(names) != 0 {
		t.Error("$out wrote the archive collection")
	}
	response := a.preview("POST", "/documents/create", `{}`)
	body := decodeBody(t, response)
	if response.Code != 409 || body["operation"] != "create" || !strings.Contains(body["detail"].(string), "can't run create inside a transaction") {
		t.Fatalf("an explicit create must be blocked: %d %s", response.Code, response.Body)
	}
}

func TestAWriteWithoutThePreviewSessionFailsThePreviewWith500(t *testing.T) {
	a := newApp(t, appOptions{monitor: true})
	response := a.preview("POST", "/escape/raw", `{}`)
	assertUnconfirmed(t, response, 500)
	// The binding cannot undo the escaped write; that is exactly why it never claims a rollback.
	_, _ = a.plain.DeleteOne(context.Background(), bson.D{{Key: "_id", Value: "escaped"}})
}

func TestAWriteWithoutTheRequestContextNeverConfirms(t *testing.T) {
	for _, guard := range []bool{false, true} {
		a := newApp(t, appOptions{monitor: true, guard: guard})
		assertUnconfirmed(t, a.preview("POST", "/escape/background", `{}`), 500)
		_, _ = a.plain.DeleteOne(context.Background(), bson.D{{Key: "_id", Value: "background"}})
	}
}

func TestAForeignSessionAndAHandlerCommitNeverConfirm(t *testing.T) {
	a := newApp(t, appOptions{monitor: true})
	for _, path := range []string{"/escape/foreign", "/escape/commit", "/session/commit", "/escape/rawcommit"} {
		assertUnconfirmed(t, a.preview("POST", path, `{}`), 500)
	}
	for _, id := range []string{"foreign", "committed", "session-commit"} {
		if a.count(t, id) != 0 {
			t.Errorf("%s reached the server", id)
		}
	}
	// The raw commitTransaction around the guard reached the server and is caught by the monitor.
}

func TestWithTransactionJoinsThePreviewTransaction(t *testing.T) {
	a := newApp(t, appOptions{monitor: true})
	response := a.preview("POST", "/session/with", `{}`)
	if response.Code != 200 || len(changesOf(t, response)) != 1 || a.count(t, "joined") != 0 {
		t.Fatalf("withTransaction must join and roll back: %d %s", response.Code, response.Body)
	}
}

func TestTheJoinedContextNeverHandsOutThePreviewSession(t *testing.T) {
	a := newApp(t, appOptions{monitor: true})
	for _, via := range []string{"with", "use"} {
		response := a.preview("POST", "/session/reach?via="+via, `{}`)
		if a.count(t, "reached") != 0 {
			_, _ = a.plain.DeleteOne(context.Background(), bson.D{{Key: "_id", Value: "reached"}})
			t.Fatalf("%s: the handler committed the Preview transaction: %d %s", via, response.Code, response.Body)
		}
		if response.Code != 200 || len(changesOf(t, response)) != 1 {
			t.Errorf("%s: the joined write must be previewed and rolled back: %d %s", via, response.Code, response.Body)
		}
	}
}

func TestBeforeImagesComeFromTheTransactionStartNotLaterCommits(t *testing.T) {
	a := newApp(t, appOptions{monitor: true})
	a.seed(t)
	response := a.preview("POST", "/documents/touch-all", `{}`)
	if response.Code != 200 {
		t.Fatalf("touch-all: %d %s", response.Code, response.Body)
	}
	for _, change := range changesOf(t, response) {
		if change["key"].(map[string]any)["_id"] == "concurrent" {
			t.Fatalf("a document committed by another request after the snapshot appeared as a Preview change: %v", change)
		}
	}
	if got := len(changesOf(t, response)); got != 1 {
		t.Errorf("only the seeded document changed in the Preview: %d changes", got)
	}
	_, _ = a.plain.DeleteOne(context.Background(), bson.D{{Key: "_id", Value: "concurrent"}})
}

func TestAPreviewThatOutlivesItsTimeLimitIsAbortedAndNeverConfirmed(t *testing.T) {
	a := newApp(t, appOptions{monitor: true, store: []mongobench.Option{mongobench.WithPreviewTimeout(250 * time.Millisecond)}})
	response := a.preview("POST", "/sleep/700", `{}`)
	assertUnconfirmed(t, response, 500)
	if a.count(t, "sleepy") != 0 || a.count(t, "after-sleep") != 0 {
		t.Error("an aborted Preview left a write behind")
	}
}

func TestAWriteConflictBetweenTwoPreviewsReachesTheHandler(t *testing.T) {
	a := newApp(t, appOptions{monitor: true})
	a.seed(t)
	first := make(chan *httptest.ResponseRecorder, 1)
	go func() { first <- a.preview("PATCH", "/slow/seeded", `{}`) }()
	select {
	case <-a.entered:
	case <-time.After(10 * time.Second):
		t.Fatal("the first Preview never wrote")
	}
	second := a.preview("PATCH", "/slow/seeded", `{}`)
	close(a.gate)
	body := decodeBody(t, second)
	if second.Code != 200 || body["status"] != float64(409) || !strings.Contains(second.Body.String(), "WriteConflict") {
		t.Errorf("the second Preview's handler must see the WriteConflict: %d %s", second.Code, second.Body)
	}
	if response := <-first; response.Code != 200 {
		t.Errorf("the first Preview: %d %s", response.Code, response.Body)
	}
}

func TestConcurrentPreviewsAndSendsNeverShareASession(t *testing.T) {
	a := newApp(t, appOptions{monitor: true})
	var wait sync.WaitGroup
	results := make([]*httptest.ResponseRecorder, 8)
	for index := range results {
		wait.Add(1)
		go func() {
			defer wait.Done()
			id := string(rune('a' + index))
			body := `{"ID":"` + id + `","Name":"N","City":"C","Password":"p"}`
			if index%2 == 0 {
				results[index] = a.preview("POST", "/documents", body)
			} else {
				results[index] = a.do("POST", "/documents", body, nil)
			}
		}()
	}
	wait.Wait()
	for index, response := range results {
		id := string(rune('a' + index))
		if index%2 == 0 {
			changes := changesOf(t, response)
			if response.Code != 200 || len(changes) != 1 || changes[0]["key"].(map[string]any)["_id"] != id || a.count(t, id) != 0 {
				t.Errorf("Preview %s: %d %v", id, response.Code, changes)
			}
		} else if response.Code != 201 || a.count(t, id) != 1 {
			t.Errorf("Send %s: %d count=%d", id, response.Code, a.count(t, id))
		}
	}
}

func TestObservedSendCommitsOnceAndTracesTheCommand(t *testing.T) {
	a := newApp(t, appOptions{monitor: true})
	response := a.do("POST", "/documents", `{"ID":"sent-doc","Name":"Sent","City":"Ely","Password":"mongo-secret-value"}`, map[string]string{"Prefer": "trace"})
	id := response.Header().Get("X-Sendproof-Trace")
	if response.Code != 201 || id == "" || a.count(t, "sent-doc") != 1 {
		t.Fatalf("observed send: %d %v", response.Code, response.Header())
	}
	trace := a.do("GET", "/sendproof/_api/traces/"+id, "", nil).Body.String()
	capabilities := a.do("GET", "/sendproof/_api/capabilities", "", nil).Body.String()
	if !strings.Contains(trace, `"operation":"insert"`) {
		t.Errorf("the trace has no insert Db entry: %s", trace)
	}
	for _, text := range []string{trace, capabilities} {
		if strings.Contains(text, "mongo-secret-value") || strings.Contains(text, "127.0.0.1") || strings.Contains(text, "hashed:") {
			t.Errorf("a capture leaked a secret: %s", text)
		}
	}
}

func TestCapabilitiesReportPreviewModeAndUnavailableOperations(t *testing.T) {
	a := newApp(t, appOptions{monitor: true})
	var body struct {
		DataStores         []sendproof.DataStoreInfo `json:"dataStores"`
		PreviewUnavailable []map[string]any          `json:"previewUnavailable"`
	}
	response := a.do("GET", "/sendproof/_api/capabilities", "", nil)
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || len(body.DataStores) != 1 ||
		body.DataStores[0] != (sendproof.DataStoreInfo{System: "mongodb", Name: "catalog", Mode: "preview"}) {
		t.Errorf("dataStores: %+v %v", body.DataStores, err)
	}
	if len(body.PreviewUnavailable) != 1 || body.PreviewUnavailable[0]["reason"] != "Preview unavailable: this operation writes to MongoDB" {
		t.Errorf("previewUnavailable: %v", body.PreviewUnavailable)
	}
}

func TestGuardModeBlocksWritesAndAllowsReads(t *testing.T) {
	a := newApp(t, appOptions{monitor: true, guard: true})
	a.seed(t)
	read := a.preview("GET", "/documents/seeded", "")
	if read.Code != 200 {
		t.Fatalf("a read must run in guard mode: %d %s", read.Code, read.Body)
	}
	response := a.preview("PATCH", "/documents/seeded", `{"Name":"Nope"}`)
	body := decodeBody(t, response)
	if response.Code != 409 || body["operation"] != "update" || body["detail"] != "Preview unavailable: this operation writes to MongoDB" {
		t.Fatalf("a write in guard mode: %d %s", response.Code, response.Body)
	}
	var stored bson.M
	_ = a.plain.FindOne(context.Background(), bson.D{{Key: "_id", Value: "seeded"}}).Decode(&stored)
	if stored["name"] != "Seeded" {
		t.Errorf("the write reached MongoDB: %v", stored)
	}
	var capabilities struct {
		DataStores []sendproof.DataStoreInfo `json:"dataStores"`
	}
	_ = json.Unmarshal(a.do("GET", "/sendproof/_api/capabilities", "", nil).Body.Bytes(), &capabilities)
	if capabilities.DataStores[0].Mode != "guard" || !strings.Contains(capabilities.DataStores[0].Reason, "doesn't support transactions") {
		t.Errorf("guard mode must say why: %+v", capabilities.DataStores)
	}
	// An ordinary Send is never blocked.
	if sent := a.do("PATCH", "/documents/seeded", `{"Name":"Sent"}`, nil); sent.Code != 200 {
		t.Errorf("a Send was blocked: %d", sent.Code)
	}
}

func TestAPreviewKeepsTheModeItBeganIn(t *testing.T) {
	a := newApp(t, appOptions{monitor: true, guard: true})
	a.seed(t)
	// The Preview begins in guard mode; detection then reports a replica set. The
	// write must still be blocked, not treated as joining a transaction it never had.
	response := a.preview("PATCH", "/flip/seeded", `{}`)
	body := decodeBody(t, response)
	if response.Code != 409 || body["operation"] != "update" {
		t.Fatalf("a Preview that began in guard mode must block the write: %d %s", response.Code, response.Body)
	}
	var stored bson.M
	_ = a.plain.FindOne(context.Background(), bson.D{{Key: "_id", Value: "seeded"}}).Decode(&stored)
	if stored["name"] != "Seeded" {
		t.Errorf("the write reached MongoDB: %v", stored)
	}
}

func TestTheChecksFailWithoutTheMonitor(t *testing.T) {
	a := newApp(t, appOptions{monitor: false})
	a.seed(t)
	response := a.preview("PATCH", "/documents/seeded", `{"Name":"Nope"}`)
	assertUnconfirmed(t, response, 500)
	var stored bson.M
	_ = a.plain.FindOne(context.Background(), bson.D{{Key: "_id", Value: "seeded"}}).Decode(&stored)
	if stored["name"] != "Seeded" {
		t.Errorf("a Preview without its tripwire must fail closed and write nothing: %v", stored)
	}
}

// A monitor installed on some other client is not the tripwire of the client the
// handles guard: the Preview must refuse to run rather than miss an escaped write.
func TestAMonitorOnAnotherClientDoesNotCountAsTheTripwire(t *testing.T) {
	store := mongobench.New()
	monitored := connect(t, store) // the store's monitor, on a client the handles never use
	if err := monitored.Ping(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	unmonitored := connect(t, nil)
	random := make([]byte, 4)
	_, _ = rand.Read(random)
	database := "tb_" + hex.EncodeToString(random)
	t.Cleanup(func() { _ = unmonitored.Database(database).Drop(context.Background()) })
	_ = store.Database(unmonitored.Database(database))
	bench, err := sendproof.New(sendproof.WithEnvironment("Development"), sendproof.WithDataStore(store))
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	bench.HandlePreview(mux, "POST /escape", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = unmonitored.Database(database).Collection("documents").InsertOne(r.Context(), bson.D{{Key: "_id", Value: "unseen"}})
		w.WriteHeader(201)
	}))
	request := httptest.NewRequest("POST", "/sendproof/_preview/escape", strings.NewReader(`{}`))
	request.Header.Set("Prefer", "tx=rollback")
	response := httptest.NewRecorder()
	bench.Middleware(mux).ServeHTTP(response, request)
	assertUnconfirmed(t, response, 500)
	if count, _ := unmonitored.Database(database).Collection("documents").CountDocuments(context.Background(), bson.D{}); count != 0 {
		t.Error("the handler ran without its tripwire and its write was not caught")
	}
}

// shifting marshals as a read the first time and as an insert afterwards, like a
// bson.M whose key order changes between two marshals.
type shifting struct{ calls *int }

func (c shifting) MarshalBSON() ([]byte, error) {
	*c.calls++
	if *c.calls == 1 {
		return bson.Marshal(bson.D{{Key: "find", Value: "documents"}})
	}
	return bson.Marshal(bson.D{{Key: "insert", Value: "documents"}, {Key: "documents", Value: bson.A{bson.D{{Key: "_id", Value: "shifted"}}}}})
}

// RunCommand must send exactly the document the guard classified.
func TestRunCommandSendsTheDocumentTheGuardClassified(t *testing.T) {
	a := newApp(t, appOptions{monitor: true, guard: true})
	mux := http.NewServeMux()
	a.bench.HandlePreview(mux, "POST /shift", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls := 0
		_ = a.store.Database(a.raw.Database()).RunCommand(r.Context(), shifting{calls: &calls}).Err()
		w.WriteHeader(200)
	}))
	request := httptest.NewRequest("POST", "/sendproof/_preview/shift", strings.NewReader(`{}`))
	request.Header.Set("Prefer", "tx=rollback")
	response := httptest.NewRecorder()
	a.bench.Middleware(mux).ServeHTTP(response, request)
	if a.count(t, "shifted") != 0 {
		t.Fatalf("a command classified as a read was sent as a write: %d %s", response.Code, response.Body)
	}
}

// Connect installs the tripwire and returns only the guarded client, so the
// application never holds an unguarded one.
func TestConnectReturnsAGuardedClientWithItsTripwire(t *testing.T) {
	_ = connect(t, nil) // skips when MongoDB is down
	store := mongobench.New()
	client, err := store.Connect(options.Client().ApplyURI(serverURL()).SetServerSelectionTimeout(2 * time.Second))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Disconnect(context.Background()) })
	if err := client.Ping(context.Background()); err != nil {
		t.Fatal(err)
	}
	random := make([]byte, 4)
	_, _ = rand.Read(random)
	database := "tb_" + hex.EncodeToString(random)
	documents := client.Database(database).Collection("documents")
	t.Cleanup(func() { _ = client.Database(database).Drop(context.Background()) })
	bench, err := sendproof.New(sendproof.WithEnvironment("Development"), sendproof.WithDataStore(store))
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	bench.HandlePreview(mux, "POST /documents", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := documents.InsertOne(r.Context(), bson.D{{Key: "_id", Value: "connected"}}); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.WriteHeader(201)
	}))
	request := httptest.NewRequest("POST", "/sendproof/_preview/documents", strings.NewReader(`{}`))
	request.Header.Set("Prefer", "tx=rollback")
	response := httptest.NewRecorder()
	bench.Middleware(mux).ServeHTTP(response, request)
	if response.Code != 200 || len(changesOf(t, response)) != 1 {
		t.Fatalf("a Preview through Connect: %d %s", response.Code, response.Body)
	}
	if count, _ := documents.CountDocuments(context.Background(), bson.D{}); count != 0 {
		t.Error("the previewed insert was committed")
	}
}
