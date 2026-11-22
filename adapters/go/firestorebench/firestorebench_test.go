package firestorebench_test

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"cloud.google.com/go/firestore"
	apiv1 "cloud.google.com/go/firestore/apiv1"
	"cloud.google.com/go/firestore/apiv1/firestorepb"
	"google.golang.org/api/option"
	statuspb "google.golang.org/genproto/googleapis/rpc/status"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/protobuf/types/known/emptypb"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/mprync/sendproof/adapters/go/firestorebench"
	"github.com/mprync/sendproof/adapters/go/sendproof"
)

// server is a fake Firestore over gRPC that records every method that reaches it,
// so a test can prove a refused write never did.
type server struct {
	firestorepb.UnimplementedFirestoreServer
	mu       sync.Mutex
	received []string
	address  string
}

func (s *server) record(method string) {
	s.mu.Lock()
	s.received = append(s.received, method[strings.LastIndex(method, "/")+1:])
	s.mu.Unlock()
}

func (s *server) requests() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.received...)
}

func (s *server) GetDocument(context.Context, *firestorepb.GetDocumentRequest) (*firestorepb.Document, error) {
	return &firestorepb.Document{Name: "projects/bench/databases/(default)/documents/orders/o-1"}, nil
}

func (s *server) BatchGetDocuments(req *firestorepb.BatchGetDocumentsRequest, stream firestorepb.Firestore_BatchGetDocumentsServer) error {
	for _, name := range req.Documents {
		_ = stream.Send(&firestorepb.BatchGetDocumentsResponse{
			Result:   &firestorepb.BatchGetDocumentsResponse_Found{Found: &firestorepb.Document{Name: name, CreateTime: timestamppb.Now(), UpdateTime: timestamppb.Now()}},
			ReadTime: timestamppb.Now(),
		})
	}
	return nil
}

func (s *server) RunQuery(_ *firestorepb.RunQueryRequest, stream firestorepb.Firestore_RunQueryServer) error {
	return stream.Send(&firestorepb.RunQueryResponse{ReadTime: timestamppb.Now()})
}

func (s *server) RunAggregationQuery(_ *firestorepb.RunAggregationQueryRequest, stream firestorepb.Firestore_RunAggregationQueryServer) error {
	return stream.Send(&firestorepb.RunAggregationQueryResponse{ReadTime: timestamppb.Now()})
}

func (s *server) BeginTransaction(context.Context, *firestorepb.BeginTransactionRequest) (*firestorepb.BeginTransactionResponse, error) {
	return &firestorepb.BeginTransactionResponse{Transaction: []byte("tx")}, nil
}

func (s *server) Rollback(context.Context, *firestorepb.RollbackRequest) (*emptypb.Empty, error) {
	return &emptypb.Empty{}, nil
}

func (s *server) Commit(_ context.Context, req *firestorepb.CommitRequest) (*firestorepb.CommitResponse, error) {
	results := make([]*firestorepb.WriteResult, len(req.Writes))
	for index := range results {
		results[index] = &firestorepb.WriteResult{UpdateTime: timestamppb.Now()}
	}
	return &firestorepb.CommitResponse{WriteResults: results, CommitTime: timestamppb.Now()}, nil
}

func (s *server) BatchWrite(_ context.Context, req *firestorepb.BatchWriteRequest) (*firestorepb.BatchWriteResponse, error) {
	response := &firestorepb.BatchWriteResponse{}
	for range req.Writes {
		response.WriteResults = append(response.WriteResults, &firestorepb.WriteResult{UpdateTime: timestamppb.Now()})
		response.Status = append(response.Status, &statuspb.Status{})
	}
	return response, nil
}

func (s *server) Write(stream firestorepb.Firestore_WriteServer) error {
	for {
		if _, err := stream.Recv(); err != nil {
			return nil
		}
		_ = stream.Send(&firestorepb.WriteResponse{StreamId: "s", StreamToken: []byte("t")})
	}
}

func newServer(t *testing.T) *server {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &server{address: listener.Addr().String()}
	grpcServer := grpc.NewServer(
		grpc.ChainUnaryInterceptor(func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
			s.record(info.FullMethod)
			return handler(ctx, req)
		}),
		grpc.ChainStreamInterceptor(func(srv any, stream grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) error {
			s.record(info.FullMethod)
			return handler(srv, stream)
		}),
	)
	firestorepb.RegisterFirestoreServer(grpcServer, s)
	go func() { _ = grpcServer.Serve(listener) }()
	t.Cleanup(grpcServer.Stop)
	return s
}

// dial returns the client options that reach the fake server, with or without the guard.
func (s *server) options(guarded bool) []option.ClientOption {
	options := []option.ClientOption{
		option.WithEndpoint(s.address), option.WithoutAuthentication(),
		option.WithGRPCDialOption(grpc.WithTransportCredentials(insecure.NewCredentials())),
	}
	if guarded {
		options = append(options, firestorebench.ClientOptions()...)
	}
	return options
}

type operation func(ctx context.Context, client *firestore.Client) error

type app struct {
	handler http.Handler
	server  *server
}

// newApp builds the app with a route per operation; each swallows the error and answers 200.
func newApp(t *testing.T, guarded bool, routes map[string]operation) *app {
	t.Helper()
	bench, err := sendproof.New(
		sendproof.WithEnvironment("Development"), sendproof.WithDataStore(firestorebench.Store("orders")),
		sendproof.WithPrincipal(func(*http.Request) (sendproof.Principal, bool) {
			return sendproof.Principal{Subject: "ada", Name: "Ada", Scheme: "cookie"}, true
		}),
	)
	if err != nil {
		t.Fatal(err)
	}
	s := newServer(t)
	client, err := firestore.NewClient(context.Background(), "bench", s.options(guarded)...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	mux := http.NewServeMux()
	for pattern, run := range routes {
		bench.HandlePreview(mux, pattern, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
			defer cancel()
			w.Header().Set("Content-Type", "application/json")
			if err := run(ctx, client); err != nil {
				_ = json.NewEncoder(w).Encode(map[string]any{"swallowed": err.Error()})
				return
			}
			_, _ = w.Write([]byte(`{}`))
		}))
	}
	return &app{handler: bench.Middleware(mux), server: s}
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

func assertBlocked(t *testing.T, response *httptest.ResponseRecorder, operation string) {
	t.Helper()
	var body map[string]any
	_ = json.Unmarshal(response.Body.Bytes(), &body)
	if response.Code != 409 || body["code"] != "preview_unavailable" || body["store"] != "firestore" || body["operation"] != operation ||
		body["detail"] != "Preview unavailable: this operation writes to Firestore" || body["rolledBack"] != false ||
		response.Header().Get("Preference-Applied") != "" {
		t.Fatalf("expected a blocked Preview for %s, got %d %s", operation, response.Code, response.Body)
	}
}

func writeRoutes() map[string]operation {
	order := func(client *firestore.Client) *firestore.DocumentRef { return client.Collection("orders").Doc("o-1") }
	return map[string]operation{
		"POST /set": func(ctx context.Context, c *firestore.Client) error {
			_, err := order(c).Set(ctx, map[string]any{"status": "open", "note": "secret"})
			return err
		},
		"POST /create": func(ctx context.Context, c *firestore.Client) error {
			_, err := order(c).Create(ctx, map[string]any{"status": "open"})
			return err
		},
		"POST /update": func(ctx context.Context, c *firestore.Client) error {
			_, err := order(c).Update(ctx, []firestore.Update{{Path: "status", Value: "closed"}})
			return err
		},
		"POST /delete": func(ctx context.Context, c *firestore.Client) error {
			_, err := order(c).Delete(ctx)
			return err
		},
		"POST /add": func(ctx context.Context, c *firestore.Client) error {
			_, _, err := c.Collection("orders").Add(ctx, map[string]any{"status": "new"})
			return err
		},
		"POST /batch": func(ctx context.Context, c *firestore.Client) error {
			_, err := c.Batch().Set(order(c), map[string]any{"a": 1}).Commit(ctx)
			return err
		},
		"POST /transaction": func(ctx context.Context, c *firestore.Client) error {
			return c.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
				if _, err := tx.Get(order(c)); err != nil {
					return err
				}
				return tx.Set(order(c), map[string]any{"status": "x"})
			})
		},
		"POST /bulk": func(ctx context.Context, c *firestore.Client) error {
			writer := c.BulkWriter(ctx)
			job, err := writer.Set(order(c), map[string]any{"a": 1})
			if err != nil {
				return err
			}
			writer.End()
			_, err = job.Results()
			return err
		},
	}
}

func TestWritesAreRefusedBeforeTheyAreSent(t *testing.T) {
	a := newApp(t, true, writeRoutes())
	want := map[string]string{
		"/set": "Commit", "/create": "Commit", "/update": "Commit", "/delete": "Commit", "/add": "Commit",
		"/batch": "Commit", "/transaction": "Commit", "/bulk": "BatchWrite",
	}
	for route, operation := range want {
		assertBlocked(t, a.preview(route), operation)
	}
	for _, method := range a.server.requests() {
		if method == "Commit" || method == "BatchWrite" || method == "Write" {
			t.Errorf("a refused write reached the server: %v", a.server.requests())
			break
		}
	}
}

func TestReadsRunInPreviewAndAreLogged(t *testing.T) {
	a := newApp(t, true, map[string]operation{
		"POST /get": func(ctx context.Context, c *firestore.Client) error {
			_, err := c.Collection("orders").Doc("o-1").Get(ctx)
			return err
		},
		"POST /query": func(ctx context.Context, c *firestore.Client) error {
			_, err := c.Collection("orders").Where("status", "==", "hush-value").Documents(ctx).GetAll()
			return err
		},
		"POST /count": func(ctx context.Context, c *firestore.Client) error {
			_, err := c.Collection("orders").NewAggregationQuery().WithCount("n").Get(ctx)
			return err
		},
		// A read-write transaction that only reads ends with an empty Commit or a Rollback, both allowed.
		"POST /txread": func(ctx context.Context, c *firestore.Client) error {
			return c.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
				_, err := tx.Get(c.Collection("orders").Doc("o-1"))
				return err
			})
		},
	})
	logs := func(response *httptest.ResponseRecorder) []map[string]any {
		var body struct {
			Logs []struct {
				DB map[string]any `json:"db"`
			} `json:"logs"`
		}
		_ = json.Unmarshal(response.Body.Bytes(), &body)
		var list []map[string]any
		for _, entry := range body.Logs {
			list = append(list, entry.DB)
		}
		return list
	}
	for route, want := range map[string]struct{ operation, target string }{
		"/get": {"BatchGetDocuments", "orders"}, "/query": {"RunQuery", "orders"}, "/count": {"RunAggregationQuery", "orders"},
	} {
		response := a.preview(route)
		if response.Code != 200 || !strings.Contains(response.Body.String(), `"rolledBack":true`) {
			t.Fatalf("%s: a read must be confirmed: %d %s", route, response.Code, response.Body)
		}
		entries := logs(response)
		if len(entries) != 1 || entries[0]["operation"] != want.operation || entries[0]["target"] != want.target || entries[0]["system"] != "firestore" {
			t.Errorf("%s: Db entries %v", route, entries)
		}
		text := response.Body.String()
		if strings.Contains(text, "hush-value") || strings.Contains(text, "o-1") {
			t.Errorf("%s: a value or document id reached the capture: %s", route, text)
		}
	}
	if response := a.preview("/txread"); response.Code != 200 {
		t.Errorf("a transaction that only reads must be confirmed: %d %s", response.Code, response.Body)
	}
}

func TestTheChecksFailWithoutTheGuard(t *testing.T) {
	a := newApp(t, false, writeRoutes())
	response := a.preview("/set")
	if response.Code != 200 {
		t.Fatalf("an unguarded client should have written: %d %s", response.Code, response.Body)
	}
	if got := a.server.requests(); len(got) == 0 || got[len(got)-1] != "Commit" {
		t.Errorf("without the guard the write reaches the server: %v", got)
	}
}

func TestSendIsNeverBlockedAndObservedSendTracesTheCall(t *testing.T) {
	a := newApp(t, true, writeRoutes())
	response := a.do("POST", "/set", map[string]string{"Prefer": "trace"})
	id := response.Header().Get("X-Sendproof-Trace")
	if response.Code != 200 || id == "" {
		t.Fatalf("observed send: %d %v", response.Code, response.Header())
	}
	trace := a.do("GET", "/sendproof/_api/traces/"+id, nil).Body.String()
	if !strings.Contains(trace, `"operation":"Commit"`) || strings.Contains(trace, "secret") || strings.Contains(trace, "o-1") {
		t.Errorf("trace: %s", trace)
	}
	if plain := a.do("POST", "/set", nil); plain.Code != 200 {
		t.Errorf("an ordinary Send was blocked: %d", plain.Code)
	}
}

// TestAWriteWithoutTheRequestContextIsRefusedBeforeItIsSent: a write that carries
// no request while a Preview is open is taken to be the Preview's, and refused.
func TestAWriteWithoutTheRequestContextIsRefusedBeforeItIsSent(t *testing.T) {
	a := newApp(t, true, map[string]operation{
		"POST /background": func(_ context.Context, c *firestore.Client) error {
			_, err := c.Collection("orders").Doc("b").Set(context.Background(), map[string]any{"a": 1})
			return err
		},
		// A BulkWriter flushes from its own goroutine, with the context it was created
		// with: here a background one, as a client helper that outlives the request has.
		"POST /bulk-background": func(_ context.Context, c *firestore.Client) error {
			writer := c.BulkWriter(context.Background())
			job, err := writer.Set(c.Collection("orders").Doc("b"), map[string]any{"a": 1})
			if err != nil {
				return err
			}
			writer.End()
			_, err = job.Results()
			return err
		},
	})
	assertBlocked(t, a.preview("/background"), "Commit")
	assertBlocked(t, a.preview("/bulk-background"), "BatchWrite")
	for _, method := range a.server.requests() {
		if method == "Commit" || method == "BatchWrite" {
			t.Errorf("an unattributed write reached the server: %v", a.server.requests())
			break
		}
	}
}

func TestCapabilitiesListTheStoreInGuardMode(t *testing.T) {
	bench, err := sendproof.New(sendproof.WithEnvironment("Development"), sendproof.WithDataStore(firestorebench.Store("orders")))
	if err != nil {
		t.Fatal(err)
	}
	var body struct {
		DataStores []sendproof.DataStoreInfo `json:"dataStores"`
	}
	response := httptest.NewRecorder()
	bench.Middleware(http.NewServeMux()).ServeHTTP(response, httptest.NewRequest("GET", "/sendproof/_api/capabilities", nil))
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || len(body.DataStores) != 1 ||
		body.DataStores[0] != (sendproof.DataStoreInfo{System: "firestore", Name: "orders", Mode: "guard"}) {
		t.Errorf("dataStores: %+v %v", body.DataStores, err)
	}
}

func TestStoreRefusesAConnectionStringAsALabel(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Error("a project path must not be accepted as a store name")
		}
	}()
	firestorebench.Store("projects/bench/databases/(default)")
}

// writeStream opens the bidirectional Write stream through the raw apiv1 client:
// the Go firestore package never uses it, but anything on the connection can.
func writeStream(ctx context.Context, address string, options ...option.ClientOption) error {
	raw, err := apiv1.NewClient(ctx, append([]option.ClientOption{
		option.WithEndpoint(address), option.WithoutAuthentication(),
		option.WithGRPCDialOption(grpc.WithTransportCredentials(insecure.NewCredentials())),
	}, options...)...)
	if err != nil {
		return err
	}
	defer raw.Close()
	stream, err := raw.Write(ctx)
	if err != nil {
		return err
	}
	if err := stream.Send(&firestorepb.WriteRequest{Database: "projects/bench/databases/(default)"}); err != nil {
		return err
	}
	_, err = stream.Recv()
	return err
}

// TestTheWriteStreamIsRefusedBeforeItsFirstMessage: Write is a bidirectional
// stream, so a unary-only interceptor lets it through and the stream interceptor
// must refuse it.
func TestTheWriteStreamIsRefusedBeforeItsFirstMessage(t *testing.T) {
	var current *app
	current = newApp(t, true, map[string]operation{
		"POST /stream": func(ctx context.Context, _ *firestore.Client) error {
			return writeStream(ctx, current.server.address, firestorebench.ClientOptions()...)
		},
		"POST /unary-only": func(ctx context.Context, _ *firestore.Client) error {
			return writeStream(ctx, current.server.address, option.WithGRPCDialOption(grpc.WithChainUnaryInterceptor(firestorebench.UnaryInterceptor())))
		},
	})
	assertBlocked(t, current.preview("/stream"), "Write")
	for _, method := range current.server.requests() {
		if method == "Write" {
			t.Fatalf("the Write stream was opened: %v", current.server.requests())
		}
	}
	// With only the unary interceptor the stream opens and the Preview is not blocked:
	// this is why ClientOptions installs both.
	if response := current.preview("/unary-only"); response.Code == 409 {
		t.Errorf("a unary-only interceptor must not see the Write stream: %d", response.Code)
	}
	opened := false
	for _, method := range current.server.requests() {
		opened = opened || method == "Write"
	}
	if !opened {
		t.Error("the unary-only control should have reached Write")
	}
}

func TestListenIsAReadAndRunsInPreview(t *testing.T) {
	a := newApp(t, true, map[string]operation{
		"POST /listen": func(ctx context.Context, c *firestore.Client) error {
			snapshots := c.Collection("orders").Snapshots(ctx)
			defer snapshots.Stop()
			_, err := snapshots.Next()
			return err
		},
	})
	response := a.preview("/listen")
	if response.Code == 409 {
		t.Fatalf("Listen is a read: %d %s", response.Code, response.Body)
	}
	listened := false
	for _, method := range a.server.requests() {
		listened = listened || method == "Listen"
	}
	if !listened {
		t.Errorf("Listen did not reach the server: %v", a.server.requests())
	}
}
