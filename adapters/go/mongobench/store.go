// Package mongobench connects the MongoDB Go driver (v2) to Sendproof Preview
// (spec/data-stores.md). On a replica set or sharded cluster a Preview runs the
// handler's MongoDB commands in a transaction that Sendproof aborts afterwards,
// and reports the document changes. On a standalone server MongoDB runs in guard
// mode: reads run and the first write blocks the Preview.
//
// No MongoDB driver offers a hook that can stop a command before it is sent:
// command monitoring reports a command but cannot veto it. So the binding has two
// parts. Guarded handles (Client, Database, Collection) have the driver's method
// set; during a Preview each call is classified before the driver builds a
// command, writes that MongoDB cannot run in a transaction (or any write, in guard
// mode) are refused, and the Preview's session is added to the call's context. And
// a command monitor, installed through ClientOptions, is the tripwire: a write
// during a Preview that did not run in the Preview's transaction fails the
// Preview with 500, because the binding cannot undo it.
//
//	store := mongobench.New(mongobench.WithName("catalog"))
//	client, _ := mongo.Connect(store.ClientOptions(options.Client().ApplyURI(url)))
//	catalog := store.Database(client.Database("catalog")) // handlers use catalog
//	bench, _ := sendproof.New(sendproof.WithDataStore(store))
//
// # Coverage
//
// Only the guarded handles are covered, and only calls made with the request's
// context: pass r.Context() to every call. The raw *mongo.Client, a second client,
// a call with context.Background(), change streams and GridFS are not guarded.
// The monitor does see a write that a raw client makes with the request's context,
// and fails the Preview with 500 instead of confirming a rollback it did not do.
package mongobench

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/mprync/sendproof/adapters/go/sendproof"
	"github.com/mprync/sendproof/adapters/go/stores"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"go.mongodb.org/mongo-driver/v2/mongo/readconcern"
	"go.mongodb.org/mongo-driver/v2/mongo/writeconcern"
)

// system is the store id of MongoDB in discovery, change records and Db entries.
const system = "mongodb"

// StandaloneReason is the reason a standalone server, or any reply the binding
// does not recognise, runs in guard mode.
const StandaloneReason = "Preview unavailable: this MongoDB server doesn't support transactions"

// DefaultPreviewTimeout is below the server's 60-second transactionLifetimeLimitSeconds,
// so the binding, not the server, ends a Preview whose handler runs too long.
const DefaultPreviewTimeout = 50 * time.Second

// candidateLimit is the most documents read back for change capture in one Preview.
const candidateLimit = 1000

// refusedReason is the reason for a command MongoDB refuses inside a transaction.
func refusedReason(operation string) string {
	return "Preview unavailable: MongoDB can't run " + operation + " inside a transaction"
}

// Option configures New.
type Option func(*Store) error

// WithName sets the display label shown in discovery, such as "catalog": never a
// connection string or host name.
func WithName(name string) Option {
	return func(s *Store) error {
		label, err := stores.Label(name)
		s.name = label
		return err
	}
}

// TreatAsRead declares commands the host states never write, by exact name (compared
// case-insensitively, as MongoDB does). A wrongly listed write is not blocked in
// guard mode.
func TreatAsRead(commands ...string) Option {
	return func(s *Store) error {
		reads, err := stores.ReadSet(commands, func(name string) string { return lower(name) })
		s.reads = reads
		return err
	}
}

// WithPreviewTimeout sets how long a Preview may hold its transaction. A Preview
// still running at the limit has its transaction aborted and answers 500 without
// confirmation. The default is DefaultPreviewTimeout.
func WithPreviewTimeout(timeout time.Duration) Option {
	return func(s *Store) error {
		if timeout <= 0 {
			return errors.New("mongobench: the Preview timeout must be positive")
		}
		s.timeout = timeout
		return nil
	}
}

// Store is one hooked MongoDB client. It implements sendproof.DataStore; create it
// with New, install its monitor with ClientOptions, and wrap the handles handlers use.
type Store struct {
	name    string
	reads   map[string]bool
	timeout time.Duration

	mu        sync.Mutex
	client    *mongo.Client
	detected  *detection
	pending   map[int64]*pendingCommand
	// monitored records that the monitor saw the detection hello, which is sent
	// through the attached client: proof that this client, not just some client,
	// was created with ClientOptions.
	monitored bool
}

// detection is the topology the engine found with hello.
type detection struct {
	mode   string
	reason string
}

// New creates the store of one MongoDB client. It panics on an invalid option,
// because that is a startup configuration error.
func New(options ...Option) *Store {
	store := &Store{timeout: DefaultPreviewTimeout, pending: map[int64]*pendingCommand{}}
	for _, option := range options {
		if err := option(store); err != nil {
			panic(err)
		}
	}
	return store
}

// ClientOptions installs the command monitor the tripwire needs on the options a
// client is created with, chaining any monitor already set. Use it before
// mongo.Connect: the driver reads the monitor only when it connects.
func (s *Store) ClientOptions(opts *options.ClientOptions) *options.ClientOptions {
	return opts.SetMonitor(s.monitor(opts.Monitor))
}

// Connect creates the store's client with its command monitor installed and
// returns only the guarded handle, so handlers never see an unguarded client. It
// is mongo.Connect(s.ClientOptions(opts)) followed by s.Client.
func (s *Store) Connect(opts *options.ClientOptions) (*Client, error) {
	if opts == nil {
		opts = options.Client()
	}
	client, err := mongo.Connect(s.ClientOptions(opts))
	if err != nil {
		return nil, err
	}
	return s.Client(client), nil
}

// attach binds the store to the client behind a guarded handle.
func (s *Store) attach(client *mongo.Client) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.client != nil && s.client != client {
		panic("mongobench: a Store guards one client; create another Store for a second client")
	}
	s.client = client
}

// internalKey marks the contexts of the engine's own commands, which the monitor ignores.
type internalKey struct{}

func internal(ctx context.Context) context.Context {
	return context.WithValue(ctx, internalKey{}, true)
}

func isInternal(ctx context.Context) bool {
	marked, _ := ctx.Value(internalKey{}).(bool)
	return marked
}

// probeKey marks the detection hello, so the monitor can tell that it is installed
// on the client the guarded handles use. The value is the Store that sent it.
type probeKey struct{}

// detect finds the topology once: preview mode on a replica set or mongos with
// logical sessions, guard mode otherwise. A failure answers guard mode for now and
// is asked again next time.
func (s *Store) detect(ctx context.Context) detection {
	s.mu.Lock()
	cached, client := s.detected, s.client
	s.mu.Unlock()
	if cached != nil {
		return *cached
	}
	if client == nil {
		return detection{mode: sendproof.ModeGuard, reason: StandaloneReason}
	}
	ctx, cancel := context.WithTimeout(context.WithValue(internal(ctx), probeKey{}, s), 10*time.Second)
	defer cancel()
	var hello bson.M
	if err := client.Database("admin").RunCommand(ctx, bson.D{{Key: "hello", Value: 1}}).Decode(&hello); err != nil {
		return detection{mode: sendproof.ModeGuard, reason: StandaloneReason}
	}
	_, replicaSet := hello["setName"]
	sharded := hello["msg"] == "isdbgrid"
	sessions := hello["logicalSessionTimeoutMinutes"] != nil
	result := detection{mode: sendproof.ModeGuard, reason: StandaloneReason}
	if (replicaSet || sharded) && sessions {
		result = detection{mode: sendproof.ModePreview}
	}
	s.mu.Lock()
	s.detected = &result
	s.mu.Unlock()
	return result
}

// Describe reports the store for discovery. It detects the topology on first use.
func (s *Store) Describe(ctx context.Context) sendproof.DataStoreInfo {
	found := s.detect(ctx)
	return sendproof.DataStoreInfo{System: system, Name: s.name, Mode: found.mode, Reason: found.reason}
}

// preview is the state of one Preview on this store. A Preview keeps the mode it
// began in: a Preview that began in guard mode never treats later writes as
// joining a transaction it does not have.
type preview struct {
	store *Store
	mode  string
	// base carries the Preview, so timers can record faults on it.
	base context.Context

	mu       sync.Mutex
	session  *mongo.Session
	lsid     string
	used     bool // a command carried the session to the server
	finished bool
	timer    *time.Timer
	// startTime is the transaction's snapshot time: the operationTime of the first
	// reply to a command the Preview session sent. Before images are read at this
	// time, so a concurrent commit by another request is never a Preview change.
	startTime  *bson.Timestamp
	candidates map[string]candidate
	order      []string
	filters    []filter
}

// candidate is a document a Preview may have changed.
type candidate struct {
	namespace, collection string
	id                    bson.RawValue
	via                   string
}

// filter is a query whose matches, before and inside the transaction, are candidates.
type filter struct {
	namespace, collection string
	query                 bson.Raw
	via                   string
}

// BeginPreview detects the mode and, in preview mode, starts the Preview's session
// and transaction with read concern snapshot and write concern majority.
func (s *Store) BeginPreview(ctx context.Context) (sendproof.StorePreview, error) {
	found := s.detect(ctx)
	p := &preview{store: s, mode: found.mode, base: ctx, candidates: map[string]candidate{}}
	if found.mode != sendproof.ModePreview {
		return p, nil
	}
	s.mu.Lock()
	client, seen := s.client, s.monitored
	s.mu.Unlock()
	if !seen {
		return nil, errors.New("mongobench: the guarded client was not created with the store's ClientOptions, so the Preview tripwire is missing")
	}
	session, err := client.StartSession()
	if err != nil {
		return nil, fmt.Errorf("mongobench: could not start the Preview session: %w", err)
	}
	transaction := options.Transaction().SetReadConcern(readconcern.Snapshot()).SetWriteConcern(writeconcern.Majority())
	if err := session.StartTransaction(transaction); err != nil {
		session.EndSession(internal(ctx))
		return nil, fmt.Errorf("mongobench: could not start the Preview transaction: %w", err)
	}
	lsid, ok := sessionID(session.ID())
	if !ok {
		session.EndSession(internal(ctx))
		return nil, errors.New("mongobench: the driver did not expose the Preview session id")
	}
	p.session, p.lsid = session, lsid
	// A handler still running at the limit loses its transaction: later commands
	// fail, nothing commits, and the Preview answers 500 when it ends.
	p.timer = time.AfterFunc(s.timeout, func() {
		_ = sendproof.RefusePreview(p.base, fmt.Sprintf("The Preview ran longer than %s, so its MongoDB transaction was aborted.", s.timeout))
		p.end()
	})
	return p, nil
}

// end aborts the Preview transaction and ends its session, once. The driver ignores
// abort errors, as the transactions specification requires; an unacknowledged abort
// still commits nothing, because no commitTransaction is ever sent for the session.
func (p *preview) end() {
	p.mu.Lock()
	if p.finished {
		p.mu.Unlock()
		return
	}
	p.finished = true
	session := p.session
	if p.timer != nil {
		p.timer.Stop()
	}
	p.mu.Unlock()
	if session != nil {
		ctx := internal(context.Background())
		_ = session.AbortTransaction(ctx)
		session.EndSession(ctx)
	}
}

// Close releases the session. It is always called.
func (p *preview) Close() error {
	p.end()
	return nil
}

// ended reports whether the transaction is over, whether by Finish or the time limit.
func (p *preview) ended() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.finished
}
