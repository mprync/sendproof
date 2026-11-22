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
//	client, _ := store.Connect(options.Client().ApplyURI(url)) // a guarded *mongobench.Client
//	catalog := client.Database("catalog")                       // handlers use catalog
//	bench, _ := sendproof.New(sendproof.WithDataStore(store))
//
// # Coverage
//
// Only the guarded handles are covered, and only calls made with the request's
// context: pass r.Context() to every call. A raw *mongo.Client, a second client,
// change streams and GridFS are not guarded. The monitor does see a write that a
// raw client makes with the request's context, and fails the Preview with 500
// instead of confirming a rollback it did not do. A guarded handle's write sent
// with context.Background() while a Preview is open is refused before it is sent
// and blocks every open Preview with 409, in either mode. Only a raw client's
// unattributed write is left to the monitor, which fails every open Preview with
// 500 after it was sent (see sendproof.ReportWrite and sendproof.Detached).
package mongobench

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
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

// UnreachableReason is the reason when the detection hello could not be sent or
// answered: whether the server supports transactions is unknown, so the store runs
// in guard mode for now and detects again on the next Preview.
const UnreachableReason = "Preview unavailable: couldn't reach MongoDB to check whether it supports transactions, so this Preview runs in guard mode"

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
		return detection{mode: sendproof.ModeGuard, reason: UnreachableReason}
	}
	ctx, cancel := context.WithTimeout(context.WithValue(internal(ctx), probeKey{}, s), 10*time.Second)
	defer cancel()
	var hello bson.M
	if err := client.Database("admin").RunCommand(ctx, bson.D{{Key: "hello", Value: 1}}).Decode(&hello); err != nil {
		// A server that answered with an error is one the binding doesn't recognise;
		// one that never answered may support transactions or not.
		if serverAnswered(err) {
			return detection{mode: sendproof.ModeGuard, reason: StandaloneReason}
		}
		return detection{mode: sendproof.ModeGuard, reason: UnreachableReason}
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
	used     bool // a write carried the session to the server
	// sent is set once any command carried the session towards the server: from
	// then on the server may hold the transaction, and its locks, until an abort
	// reaches it.
	sent     bool
	finished bool
	timer    *time.Timer
	// inflight is held for reading by every guarded call that carries the session
	// (see guardCall) and for writing by end, so the abort waits for calls already
	// past the ended check and none reaches the server after it.
	inflight sync.RWMutex
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

// windowHooks are test hooks (see export_test.go); both are nil in production.
var windowHooks struct{ afterCheck, afterAbort func() }

// How long the store keeps trying to end a Preview transaction whose abort the
// server never acknowledged, and the backoff between tries: well inside the
// server's 60-second lifetime limit.
const (
	killRetryLimit = 10 * time.Second
	killFirstDelay = 100 * time.Millisecond
	killMaxDelay   = 2 * time.Second
	// killTryLimit bounds one killSessions try (context.WithTimeout also stops at the
	// window's own deadline, whichever comes first).
	killTryLimit = 2 * time.Second
)

// abortKey marks the context of the engine's own abortTransaction. Its value is set
// by the monitor when the server answered the abort.
type abortKey struct{}

// end aborts the Preview transaction and ends its session, once. It reports
// whether the transaction is known to be over.
//
// The driver ignores abort errors, as the transactions specification requires: an
// unacknowledged abort still commits nothing, because no commitTransaction is ever
// sent for the session. But the server then keeps the transaction, and its locks,
// until its 60-second lifetime limit. So when a command was sent on the session and
// the server never answered the abort (the connection dropped), end returns false
// at once, and the Preview answers 500, while the session is killed in the
// background.
func (p *preview) end() bool {
	p.mu.Lock()
	if p.finished {
		p.mu.Unlock()
		return true
	}
	p.finished = true
	session := p.session
	if p.timer != nil {
		p.timer.Stop()
	}
	p.mu.Unlock()
	if session == nil {
		return true
	}
	// Calls that passed the ended check finish inside the transaction first; later ones are refused.
	p.inflight.Lock()
	defer p.inflight.Unlock()
	acknowledged := &atomic.Bool{}
	ctx := internal(context.Background())
	_ = session.AbortTransaction(context.WithValue(ctx, abortKey{}, acknowledged))
	if hook := windowHooks.afterAbort; hook != nil {
		hook()
	}
	p.mu.Lock()
	sent := p.sent
	p.mu.Unlock()
	if sent && !acknowledged.Load() {
		go p.kill(session)
		return false
	}
	session.EndSession(ctx)
	return true
}

// kill ends a Preview transaction whose abort the server never acknowledged with
// killSessions, retrying with backoff while the server can't be reached. A final
// failure is logged with the session id: the server then ends the transaction at
// its lifetime limit. The session is ended only afterwards, so the driver can't
// hand its id to another operation meanwhile.
func (p *preview) kill(session *mongo.Session) {
	defer session.EndSession(internal(context.Background()))
	p.store.killSession(session.ID(), p.lsid)
}

// killHooks are test hooks (see export_test.go); nil in production.
var killHooks struct{ try func() }

// killSession sends killSessions for the session id document id, retrying with
// backoff for up to killRetryLimit while the server can't be reached. Each try
// gives up after killTryLimit, or the time left, so a try never waits out the
// driver's 30-second server selection timeout. It reports whether the server
// killed the session; a final failure is logged with lsid.
func (s *Store) killSession(id bson.Raw, lsid string) bool {
	ctx, cancel := context.WithTimeout(internal(context.Background()), killRetryLimit)
	defer cancel()
	failure := fmt.Sprintf("MongoDB couldn't be reached for %s", killRetryLimit)
	delay := killFirstDelay
	for {
		if hook := killHooks.try; hook != nil {
			hook()
		}
		try, stop := context.WithTimeout(ctx, killTryLimit)
		err := s.client.Database("admin").RunCommand(try, bson.D{{Key: "killSessions", Value: bson.A{id}}}).Err()
		stop()
		if err == nil {
			return true
		}
		if serverAnswered(err) {
			failure = err.Error()
			break
		}
		// A network error or no server to select: try again shortly.
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
		case <-timer.C:
		}
		if ctx.Err() != nil {
			break
		}
		delay = min(delay*2, killMaxDelay)
	}
	slog.Warn("mongobench: couldn't end a MongoDB Preview transaction; the server ends it, and releases its locks, at transactionLifetimeLimitSeconds",
		"session", lsid, "failure", failure)
	return false
}

// serverAnswered reports whether the server itself answered with err, rather than
// the driver failing to reach it.
func serverAnswered(err error) bool {
	var server mongo.ServerError
	if !errors.As(err, &server) || mongo.IsNetworkError(err) || mongo.IsTimeout(err) {
		return false
	}
	var command mongo.CommandError
	return !errors.As(err, &command) || command.Code != 0
}

// Close releases the session. It is always called. A Preview dropped before Finish
// whose abort is lost still has its session killed in the background.
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
