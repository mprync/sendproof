package mongobench_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mprync/sendproof/adapters/go/mongobench"
	"github.com/mprync/sendproof/adapters/go/sendproof"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/event"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// proxy is a TCP proxy to the compose MongoDB that can cut every connection and
// refuse new ones: the network failing in the middle of a Preview.
type proxy struct {
	listener net.Listener
	mu       sync.Mutex
	down     bool
	links    map[net.Conn]bool
}

func startProxy(t *testing.T) *proxy {
	t.Helper()
	target, err := url.Parse(serverURL())
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := &proxy{listener: listener, links: map[net.Conn]bool{}}
	t.Cleanup(func() { _ = listener.Close(); p.cut() })
	go func() {
		for {
			client, err := listener.Accept()
			if err != nil {
				return
			}
			p.mu.Lock()
			if p.down {
				p.mu.Unlock()
				_ = client.Close()
				continue
			}
			upstream, err := net.Dial("tcp", target.Host)
			if err != nil {
				p.mu.Unlock()
				_ = client.Close()
				continue
			}
			p.links[client], p.links[upstream] = true, true
			p.mu.Unlock()
			pipe := func(to, from net.Conn) {
				_, _ = io.Copy(to, from)
				_ = to.Close()
				_ = from.Close()
			}
			go pipe(upstream, client)
			go pipe(client, upstream)
		}
	}()
	return p
}

func (p *proxy) url(database string) string {
	return "mongodb://" + p.listener.Addr().String() + "/" + database + "?directConnection=true"
}

// cut closes every connection and refuses new ones until restore.
func (p *proxy) cut() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.down = true
	for link := range p.links {
		_ = link.Close()
	}
	p.links = map[net.Conn]bool{}
}

func (p *proxy) restore() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.down = false
}

// commandNames records the name of every command a client sends, the store's own included.
type commandNames struct {
	mu    sync.Mutex
	names []string
}

func (c *commandNames) monitor() *event.CommandMonitor {
	return &event.CommandMonitor{Started: func(_ context.Context, e *event.CommandStartedEvent) {
		c.mu.Lock()
		defer c.mu.Unlock()
		c.names = append(c.names, e.CommandName)
	}}
}

func (c *commandNames) has(name string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, sent := range c.names {
		if sent == name {
			return true
		}
	}
	return false
}

// abortApp is a bench on a fresh seeded database whose store's client connects to
// uri; its PATCH handler updates the seeded document, then runs after.
type abortApp struct {
	handler http.Handler
	plain   *mongo.Client
	docs    *mongo.Collection // the plain client's view of the documents
	sent    *commandNames
}

func newAbortApp(t *testing.T, uri func(database string) string, after func()) *abortApp {
	t.Helper()
	plain := connect(t, nil) // skips when MongoDB is down
	random := make([]byte, 4)
	_, _ = rand.Read(random)
	database := "tb_" + hex.EncodeToString(random)
	t.Cleanup(func() { _ = plain.Database(database).Drop(context.Background()) })
	docs := plain.Database(database).Collection("documents")
	if _, err := docs.InsertOne(context.Background(), bson.D{{Key: "_id", Value: "seeded"}, {Key: "name", Value: "Seeded"}}); err != nil {
		t.Fatal(err)
	}
	sent := &commandNames{}
	store := mongobench.New(mongobench.WithName("catalog"))
	// The store's client gives up quickly when it can't reach the server: when the
	// connection is cut the driver's own abort fails, and the driver hides that failure.
	client, err := store.Connect(options.Client().ApplyURI(uri(database)).SetServerSelectionTimeout(time.Second).SetMonitor(sent.monitor()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Disconnect(context.Background()) })
	guarded := client.Database(database).Collection("documents")
	bench, err := sendproof.New(sendproof.WithEnvironment("Development"), sendproof.WithDataStore(store))
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	bench.HandlePreview(mux, "PATCH /documents/{id}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := guarded.UpdateOne(r.Context(), bson.D{{Key: "_id", Value: r.PathValue("id")}}, bson.D{{Key: "$set", Value: bson.D{{Key: "name", Value: "Preview"}}}}); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		after()
		w.WriteHeader(200)
	}))
	bench.HandlePreview(mux, "GET /nothing", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
	return &abortApp{handler: bench.Middleware(mux), plain: plain, docs: docs, sent: sent}
}

func (a *abortApp) preview(method, path string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, "/sendproof/_preview"+path, strings.NewReader(`{}`))
	request.Header.Set("Prefer", "tx=rollback")
	response := httptest.NewRecorder()
	a.handler.ServeHTTP(response, request)
	return response
}

// lockReleasedWithin reports whether a transaction on the plain client can write
// the seeded document within limit: no Preview transaction still holds its lock.
func (a *abortApp) lockReleasedWithin(t *testing.T, limit time.Duration) bool {
	t.Helper()
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		session, err := a.plain.StartSession()
		if err != nil {
			t.Fatal(err)
		}
		ctx := mongo.NewSessionContext(context.Background(), session)
		err = session.StartTransaction()
		if err == nil {
			_, err = a.docs.UpdateOne(ctx, bson.D{{Key: "_id", Value: "seeded"}}, bson.D{{Key: "$set", Value: bson.D{{Key: "name", Value: "Second"}}}})
		}
		if err == nil {
			err = session.CommitTransaction(ctx)
		}
		_ = session.AbortTransaction(ctx)
		session.EndSession(context.Background())
		if err == nil {
			return true
		}
		var server mongo.ServerError
		// WriteConflict: the Preview transaction still holds the document.
		if !errors.As(err, &server) || !server.HasErrorCode(112) {
			t.Fatalf("the second transaction failed: %v", err)
		}
		time.Sleep(200 * time.Millisecond)
	}
	return false
}

func TestAPreviewWhoseAbortIsLostAnswers500AtOnceAndItsLocksAreReleased(t *testing.T) {
	network := startProxy(t)
	restored := make(chan struct{})
	a := newAbortApp(t, network.url, func() {
		// The network fails after the handler, before the Preview finishes, and stays down for 8 seconds.
		network.cut()
		time.AfterFunc(8*time.Second, func() { network.restore(); close(restored) })
	})
	started := time.Now()
	response := a.preview("PATCH", "/documents/seeded")
	if elapsed := time.Since(started); elapsed > 6*time.Second {
		t.Errorf("the reply waited for the network: %s", elapsed)
	}
	assertUnconfirmed(t, response, 500)
	<-restored
	// Without killSessions the transaction keeps its lock until the server's 60-second lifetime limit.
	if !a.lockReleasedWithin(t, 15*time.Second) {
		t.Fatal("the Preview still holds its transaction")
	}
	if !a.sent.has("killSessions") {
		t.Error("the store never sent killSessions")
	}
	var stored bson.M
	_ = a.docs.FindOne(context.Background(), bson.D{{Key: "_id", Value: "seeded"}}).Decode(&stored)
	if stored["name"] != "Second" {
		t.Errorf("nothing of the Preview may be committed: %v", stored)
	}
}

func TestANormalPreviewSendsNoKillSessions(t *testing.T) {
	a := newAbortApp(t, func(database string) string {
		target, _ := url.Parse(serverURL())
		target.Path = "/" + database
		return target.String()
	}, func() {})
	for _, path := range []string{"/documents/seeded", "/nothing"} {
		method := map[string]string{"/documents/seeded": "PATCH", "/nothing": "GET"}[path]
		if response := a.preview(method, path); response.Code != 200 || response.Header().Get("Preference-Applied") != "tx=rollback" {
			t.Fatalf("%s %s: %d %s", method, path, response.Code, response.Body)
		}
	}
	if !a.sent.has("abortTransaction") {
		t.Error("the written Preview was never aborted")
	}
	if a.sent.has("killSessions") {
		t.Errorf("an acknowledged abort needs no killSessions: %v", a.sent.names)
	}
	var stored bson.M
	_ = a.docs.FindOne(context.Background(), bson.D{{Key: "_id", Value: "seeded"}}).Decode(&stored)
	if stored["name"] != "Seeded" {
		t.Errorf("the Preview committed: %v", stored)
	}
}

func TestAServerDetectionCouldNotReachRunsInGuardModeAndSaysSo(t *testing.T) {
	if mongobench.UnreachableReason != "Preview unavailable: couldn't reach MongoDB to check whether it supports transactions, so this Preview runs in guard mode" ||
		mongobench.UnreachableReason == mongobench.StandaloneReason {
		t.Fatalf("UnreachableReason: %q", mongobench.UnreachableReason)
	}
	// Nothing listens on a closed listener's port: detection's hello can't be sent.
	closed, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := closed.Addr().String()
	_ = closed.Close()
	store := mongobench.New(mongobench.WithName("catalog"))
	client, err := store.Connect(options.Client().ApplyURI("mongodb://" + address + "/?directConnection=true").SetServerSelectionTimeout(300 * time.Millisecond))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Disconnect(context.Background()) })
	documents := client.Database("unreachable").Collection("documents")
	bench, err := sendproof.New(sendproof.WithEnvironment("Development"), sendproof.WithDataStore(store))
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	bench.HandlePreview(mux, "POST /documents", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := documents.InsertOne(r.Context(), bson.D{{Key: "_id", Value: "blocked"}}); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.WriteHeader(201)
	}))
	handler := bench.Middleware(mux)
	capabilities := httptest.NewRecorder()
	handler.ServeHTTP(capabilities, httptest.NewRequest("GET", "/sendproof/_api/capabilities", nil))
	var body struct {
		DataStores []sendproof.DataStoreInfo `json:"dataStores"`
	}
	if err := json.Unmarshal(capabilities.Body.Bytes(), &body); err != nil || len(body.DataStores) != 1 ||
		body.DataStores[0] != (sendproof.DataStoreInfo{System: "mongodb", Name: "catalog", Mode: "guard", Reason: mongobench.UnreachableReason}) {
		t.Fatalf("dataStores: %+v %v", body.DataStores, err)
	}
	blocked := httptest.NewRecorder()
	request := httptest.NewRequest("POST", "/sendproof/_preview/documents", strings.NewReader(`{}`))
	request.Header.Set("Prefer", "tx=rollback")
	handler.ServeHTTP(blocked, request)
	if blocked.Code != 409 || !strings.Contains(blocked.Body.String(), `"operation":"insert"`) {
		t.Fatalf("a write while detection can't reach the server must block: %d %s", blocked.Code, blocked.Body)
	}
}
