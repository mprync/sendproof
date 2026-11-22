// Package firestorebench guards Google Cloud Firestore clients (cloud.google.com/go/firestore,
// native mode, gRPC) for Sendproof Preview (spec/data-stores.md, store mode "guard").
//
// The Firestore client talks gRPC, and gRPC clients take dial options. The guard is
// a pair of interceptors, one for unary calls and one for streams, added to the
// client's dial options:
//
//	client, _ := firestore.NewClient(ctx, project, firestorebench.ClientOptions()...)
//	bench, _ := sendproof.New(sendproof.WithDataStore(firestorebench.Store("orders")))
//
// Both interceptors are needed, so ClientOptions adds both. RunQuery,
// BatchGetDocuments and Listen are server-streaming or bidirectional calls, and
// Write is a bidirectional stream: a unary-only interceptor would let Write
// through, so the stream interceptor refuses it before its first message is sent.
// A Commit is a write when it carries at least one write; one with none only ends a
// transaction that wrote nothing and is allowed. BatchWrite and the document RPCs
// are writes, and any method of another service or API version is a write unless
// it is an admin Get or List (spec/data-stores/firestore.json).
//
// Reads run normally. During a Preview the first write is refused before it is
// sent, with a *sendproof.PreviewWriteBlockedError wrapped in a gRPC error status
// of the client's own error handling, and the Preview answers HTTP 409 whatever the
// handler does with it. Every other call becomes a Db log entry whose statement is
// the request message as JSON with every literal, document paths included,
// replaced by "?". OAuth tokens and authorization metadata are never read.
//
// # Coverage
//
// Every collection, document, query, transaction and batch of a client built with
// these options is guarded, because they share the client's connection. Only
// clients built with the options are covered, and only calls made with the
// request's context: pass r.Context() (or a context derived from it) to every call.
// A client built without the options, a second client for the same database and a
// call made with context.Background() are not guarded; the last one, while a Preview
// is open, is refused before it is sent and blocks every open Preview. So is a
// write from the client's own goroutine, such as a BulkWriter created with a
// background context (mark background work with sendproof.Detached). A call
// carrying the context of a Preview that has ended is refused too.
//
// A BulkWriter queues writes and sends them later with its own context, so use
// NewBulkWriter: its Create, Set, Update and Delete take the caller's context and
// refuse a write when it is queued. A raw client.BulkWriter is guarded only when it
// sends, with the context it was created with: a writer created with a Detached
// context sends what a Preview's handler queued.
package firestorebench

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"time"

	"google.golang.org/api/option"
	"google.golang.org/grpc"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	"github.com/mprync/sendproof/adapters/go/sendproof"
	"github.com/mprync/sendproof/adapters/go/stores"
)

// system is the store id of Firestore in discovery and Db entries.
const system = "firestore"

// Store returns the data store for sendproof.WithDataStore. name is an optional
// display label for discovery, such as "orders": never a project URL or credentials.
// It panics on a label that looks like connection details.
func Store(name string) sendproof.DataStore {
	label, err := stores.Label(name)
	if err != nil {
		panic(err)
	}
	return &store{name: label}
}

// store is the discovery entry of a guarded client. A Firestore transaction cannot
// hold back an arbitrary handler's writes, so it prepares nothing per Preview.
type store struct{ name string }

func (s *store) Describe(context.Context) sendproof.DataStoreInfo {
	return sendproof.DataStoreInfo{System: system, Name: s.name, Mode: sendproof.ModeGuard}
}

func (s *store) BeginPreview(context.Context) (sendproof.StorePreview, error) { return nil, nil }

// DialOptions returns the unary and the stream interceptor as gRPC dial options.
// Add both to every connection to Firestore; adding only one leaves the other
// kind of call unguarded.
func DialOptions() []grpc.DialOption {
	return []grpc.DialOption{
		grpc.WithChainUnaryInterceptor(UnaryInterceptor()),
		grpc.WithChainStreamInterceptor(StreamInterceptor()),
	}
}

// ClientOptions returns DialOptions as client options for firestore.NewClient and
// the apiv1 client.
func ClientOptions() []option.ClientOption {
	var options []option.ClientOption
	for _, dial := range DialOptions() {
		options = append(options, option.WithGRPCDialOption(dial))
	}
	return options
}

// UnaryInterceptor guards and logs unary calls (Commit, BatchWrite, GetDocument,
// BeginTransaction and the rest).
func UnaryInterceptor() grpc.UnaryClientInterceptor {
	return func(ctx context.Context, method string, req, reply any, conn *grpc.ClientConn, invoker grpc.UnaryInvoker, opts ...grpc.CallOption) error {
		started, decision, err := begin(ctx, method, req)
		if err != nil {
			return err
		}
		failure := invoker(ctx, method, req, reply, conn, opts...)
		finish(ctx, decision, req, started, failure)
		return failure
	}
}

// StreamInterceptor guards and logs streaming calls (RunQuery, BatchGetDocuments,
// Listen, Write). A stream whose method is a write is refused before it is opened,
// so its first message is never sent.
func StreamInterceptor() grpc.StreamClientInterceptor {
	return func(ctx context.Context, desc *grpc.StreamDesc, conn *grpc.ClientConn, method string, streamer grpc.Streamer, opts ...grpc.CallOption) (grpc.ClientStream, error) {
		// A stream's messages are not known yet; Commit is never a stream, so
		// an unreadable message classifies as a write only for Commit.
		started, decision, err := begin(ctx, method, nil)
		if err != nil {
			return nil, err
		}
		stream, err := streamer(ctx, desc, conn, method, opts...)
		if err != nil {
			finish(ctx, decision, nil, started, err)
			return nil, err
		}
		if decision.Kind == stores.Session {
			return stream, nil
		}
		logged := &loggedStream{ClientStream: stream, ctx: ctx, decision: decision, started: started}
		// A stream the caller abandons (a cancelled Listen) still gets its entry.
		stop := context.AfterFunc(ctx, func() { logged.finish(ctx.Err()) })
		logged.stop = stop
		return logged, nil
	}
}

// begin classifies the call and asks the guard. A refused write returns its error
// and nothing has been sent.
func begin(ctx context.Context, method string, req any) (time.Time, stores.Decision, error) {
	decision := stores.ClassifyFirestoreRPC(method, commitWrites(req))
	if err := sendproof.Guard(ctx, system, decision.Operation, decision.Kind == stores.Write, ""); err != nil {
		return time.Time{}, decision, err
	}
	return time.Now(), decision, nil
}

// commitWrites is the number of writes in a request message that has a repeated
// "writes" field (CommitRequest), or -1 when the message is not known or has none.
func commitWrites(req any) int {
	message, ok := req.(proto.Message)
	if !ok || message == nil {
		return -1
	}
	reflected := message.ProtoReflect()
	field := reflected.Descriptor().Fields().ByName("writes")
	if field == nil || !field.IsList() {
		return -1
	}
	return reflected.Get(field).List().Len()
}

// finish logs the call as a Db entry. Session calls (BeginTransaction, Rollback, an
// empty Commit) are never logged.
func finish(ctx context.Context, decision stores.Decision, req any, started time.Time, failure error) {
	if decision.Kind == stores.Session {
		return
	}
	call := sendproof.DbCall{System: system, Operation: decision.Operation, RowsAffected: sendproof.UnknownRows, Duration: time.Since(started)}
	if message, ok := req.(proto.Message); ok && message != nil {
		call.Statement, call.Target = describe(message)
	}
	if failure != nil && !errors.Is(failure, io.EOF) {
		call.Error = errorName(failure)
	}
	sendproof.RecordDb(ctx, call)
}

// describe renders the request message as JSON with every literal replaced by "?"
// and finds the collection it names.
func describe(message proto.Message) (statement, target string) {
	text, err := protojson.MarshalOptions{UseProtoNames: false}.Marshal(message)
	if err != nil {
		return `"?"`, ""
	}
	var generic map[string]any
	_ = json.Unmarshal(text, &generic)
	return stores.SanitizeJSON(text), collectionOf(generic)
}

// collectionOf finds a collection id in a request message: a structured query's
// from clause, or the parent collection of the first document path it names.
func collectionOf(message map[string]any) string {
	for _, key := range []string{"structuredQuery", "structuredAggregationQuery"} {
		if query, ok := message[key].(map[string]any); ok {
			if nested, ok := query["structuredQuery"].(map[string]any); ok {
				query = nested
			}
			if from, ok := query["from"].([]any); ok && len(from) > 0 {
				if first, ok := from[0].(map[string]any); ok {
					if id, ok := first["collectionId"].(string); ok {
						return id
					}
				}
			}
		}
	}
	if writes, ok := message["writes"].([]any); ok && len(writes) > 0 {
		if first, ok := writes[0].(map[string]any); ok {
			if update, ok := first["update"].(map[string]any); ok {
				return collectionFromPath(update["name"])
			}
			for _, key := range []string{"delete", "transform"} {
				if path, ok := first[key].(string); ok {
					return collectionFromPath(path)
				}
			}
		}
	}
	if documents, ok := message["documents"].([]any); ok && len(documents) > 0 {
		return collectionFromPath(documents[0])
	}
	for _, key := range []string{"name", "collectionId"} {
		if value, ok := message[key].(string); ok {
			if key == "collectionId" {
				return value
			}
			return collectionFromPath(value)
		}
	}
	return ""
}

// collectionFromPath returns the collection id of a document path
// (projects/p/databases/d/documents/orders/o-1 is orders).
func collectionFromPath(value any) string {
	path, _ := value.(string)
	_, after, found := strings.Cut(path, "/documents/")
	if !found {
		return ""
	}
	segments := strings.Split(strings.Trim(after, "/"), "/")
	if len(segments)%2 == 0 {
		return segments[len(segments)-2]
	}
	return segments[len(segments)-1]
}

// errorName is the gRPC status code name of a failed call, or "Error".
func errorName(err error) string {
	if coded, ok := status.FromError(err); ok {
		return coded.Code().String()
	}
	return "Error"
}

// loggedStream records the one request message of a server-streaming call and logs
// the call when the stream ends.
type loggedStream struct {
	grpc.ClientStream
	ctx      context.Context
	decision stores.Decision
	started  time.Time
	stop     func() bool

	mu       sync.Mutex
	request  proto.Message
	finished bool
}

func (s *loggedStream) SendMsg(message any) error {
	if typed, ok := message.(proto.Message); ok {
		s.mu.Lock()
		if s.request == nil {
			s.request = typed
		}
		s.mu.Unlock()
	}
	return s.ClientStream.SendMsg(message)
}

func (s *loggedStream) RecvMsg(message any) error {
	err := s.ClientStream.RecvMsg(message)
	if err != nil {
		s.finish(err)
	}
	return err
}

// finish logs the call once.
func (s *loggedStream) finish(failure error) {
	s.mu.Lock()
	done, request := s.finished, s.request
	s.finished = true
	s.mu.Unlock()
	if done {
		return
	}
	if s.stop != nil {
		s.stop()
	}
	var message any
	if request != nil {
		message = request
	}
	finish(s.ctx, s.decision, message, s.started, failure)
}
