// Package cassandrabench guards Apache Cassandra (and ScyllaDB) sessions of the
// gocql driver for Sendproof Preview (spec/data-stores.md, store mode "guard").
//
// gocql's Session is a struct with no extension point before a statement is sent
// (a QueryObserver runs afterwards), so the guard is a wrapper: the application
// connects through it and its handlers use the wrapper's Session, Query and Batch,
// which have gocql's own method names:
//
//	cluster := gocql.NewCluster("cassandra:9042")
//	cluster.Keyspace = "inventory"
//	session, _ := cassandrabench.Connect(cluster) // handlers use this; no raw session is kept
//	defer session.Close()
//	bench, _ := sendproof.New(sendproof.WithDataStore(cassandrabench.Store("tickets")))
//
//	err := session.Query(`SELECT status FROM tickets WHERE id = ?`, id).WithContext(r.Context()).Scan(&status)
//
// The wrapper sits above the driver's own prepare, so it sees the CQL text of every
// call, prepared or not. Reads run normally. During a Preview the first write is
// refused before anything is sent, with a *sendproof.PreviewWriteBlockedError, and
// the Preview answers HTTP 409 whatever the handler does with the error. Every
// BATCH, logged, unlogged or counter, is a write, and so is a lightweight
// transaction (IF NOT EXISTS, IF EXISTS, IF <condition>); a text with a second
// statement, an unterminated quote or comment, or no statement at all is a write.
// Every other statement becomes a Db log entry whose statement has every literal
// replaced by ? and whose bound values are never logged.
//
// A method gocql's Query, Batch or Session has and the wrapper does not is not
// offered, so it can't be called unguarded by accident; every query and batch the
// wrapper makes (through WithContext, Bind, Batch.Query and the rest) stays guarded.
//
// # Coverage
//
// Only the wrapper is guarded. A raw *gocql.Session kept by the application (or
// created for the same cluster elsewhere) is not covered: its writes are neither
// blocked nor rolled back. Use Connect so no raw session exists, and give the
// wrapper the request's context with WithContext (or ExecContext, IterContext and
// the other Context methods): a statement sent with no context belongs to no
// request, so while a Preview is open it is refused before it is sent and blocks
// that Preview, like any write (a client's own background goroutine is the same);
// mark background work with sendproof.Detached.
package cassandrabench

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	gocql "github.com/apache/cassandra-gocql-driver/v2"

	"github.com/mprync/sendproof/adapters/go/sendproof"
	"github.com/mprync/sendproof/adapters/go/stores"
)

// system is the store id of Cassandra in discovery and Db entries.
const system = "cassandra"

// Store returns the data store for sendproof.WithDataStore. name is an optional
// display label for discovery, such as "tickets": never a host name or credentials.
// It panics on a label that looks like connection details.
func Store(name string) sendproof.DataStore {
	label, err := stores.Label(name)
	if err != nil {
		panic(err)
	}
	return &store{name: label}
}

// store is the discovery entry of a guarded session. Cassandra has no rollback, so
// it prepares nothing per Preview.
type store struct{ name string }

func (s *store) Describe(context.Context) sendproof.DataStoreInfo {
	return sendproof.DataStoreInfo{System: system, Name: s.name, Mode: sendproof.ModeGuard}
}

func (s *store) BeginPreview(context.Context) (sendproof.StorePreview, error) { return nil, nil }

// Session is a gocql session behind the guard.
type Session struct{ raw *gocql.Session }

// Connect creates the gocql session for cluster and returns only the guarded
// wrapper, so the application never holds an unguarded session.
func Connect(cluster *gocql.ClusterConfig) (*Session, error) {
	raw, err := cluster.CreateSession()
	if err != nil {
		return nil, err
	}
	return &Session{raw: raw}, nil
}

// Wrap guards a session created elsewhere. Prefer Connect: the caller's own
// reference to the raw session stays unguarded.
func Wrap(raw *gocql.Session) *Session { return &Session{raw: raw} }

// Close closes the session.
func (s *Session) Close() { s.raw.Close() }

// Closed reports whether the session is closed.
func (s *Session) Closed() bool { return s.raw.Closed() }

// KeyspaceMetadata returns the schema of a keyspace, read from the system tables.
func (s *Session) KeyspaceMetadata(keyspace string) (*gocql.KeyspaceMetadata, error) {
	return s.raw.KeyspaceMetadata(keyspace)
}

// Query creates a guarded query, like gocql.Session.Query.
func (s *Session) Query(stmt string, values ...any) *Query {
	return &Query{raw: s.raw.Query(stmt, values...)}
}

// Bind creates a guarded query whose values come from binder, like gocql.Session.Bind.
func (s *Session) Bind(stmt string, binder func(q *gocql.QueryInfo) ([]any, error)) *Query {
	return &Query{raw: s.raw.Bind(stmt, binder)}
}

// Batch creates a guarded batch, like gocql.Session.Batch. Every batch is a write:
// a Preview refuses it before anything is sent.
func (s *Session) Batch(typ gocql.BatchType) *Batch {
	return &Batch{raw: s.raw.Batch(typ)}
}

// ExecuteBatch executes a batch, like gocql.Session.ExecuteBatch.
func (s *Session) ExecuteBatch(batch *Batch) error { return batch.Exec() }

// ExecuteBatchCAS executes a batch with lightweight transactions, like gocql.Session.ExecuteBatchCAS.
func (s *Session) ExecuteBatchCAS(batch *Batch, dest ...any) (bool, *gocql.Iter, error) {
	return batch.ExecCAS(dest...)
}

// MapExecuteBatchCAS is ExecuteBatchCAS scanning into a map.
func (s *Session) MapExecuteBatchCAS(batch *Batch, dest map[string]any) (bool, *gocql.Iter, error) {
	return batch.MapExecCAS(dest)
}

// call is one statement or batch about to be sent.
type call struct {
	decision  stores.Decision
	statement string
	keyspace  string
	table     string
	started   time.Time
}

// begin asks the guard about a statement. A refused write returns its error, and
// nothing has been sent.
func begin(ctx context.Context, text, defaultKeyspace string) (*call, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	decision := stores.ClassifyCQL(text)
	if err := sendproof.Guard(ctx, system, decision.Operation, decision.Kind == stores.Write, ""); err != nil {
		return nil, err
	}
	keyspace, table := stores.CQLTarget(text)
	if keyspace == "" {
		keyspace = defaultKeyspace
	}
	return &call{decision: decision, statement: stores.SanitizeLiterals(text, false), keyspace: keyspace, table: table, started: time.Now()}, nil
}

// finish logs the statement as a Db entry. USE is a read but changes no data, and
// is logged like one.
func (c *call) finish(ctx context.Context, failure error) {
	if ctx == nil {
		ctx = context.Background()
	}
	entry := sendproof.DbCall{
		System: system, Operation: c.decision.Operation, Target: c.table, Namespace: c.keyspace,
		Statement: c.statement, RowsAffected: sendproof.UnknownRows, Duration: time.Since(c.started),
	}
	if failure != nil && !errors.Is(failure, gocql.ErrNotFound) {
		entry.Error = errorName(failure)
	}
	sendproof.RecordDb(ctx, entry)
}

// errorName is the driver's error type name (RequestErrUnavailable), or "Error".
func errorName(err error) string {
	var request gocql.RequestError
	if errors.As(err, &request) {
		return strings.TrimPrefix(fmt.Sprintf("%T", request), "gocql.")
	}
	return "Error"
}

// Query is a guarded gocql query. Its chaining methods return the same guarded
// query (WithContext returns a guarded copy), and every method that sends it asks
// the guard first.
type Query struct{ raw *gocql.Query }

// Statement returns the CQL text.
func (q *Query) Statement() string { return q.raw.Statement() }

// Keyspace returns the keyspace the query runs against.
func (q *Query) Keyspace() string { return q.raw.Keyspace() }

// WithContext sets the context that governs the query's lifetime and attributes it
// to its request. Pass r.Context().
func (q *Query) WithContext(ctx context.Context) *Query { return &Query{raw: q.raw.WithContext(ctx)} }

// Bind sets the values of the query.
func (q *Query) Bind(values ...any) *Query { q.raw = q.raw.Bind(values...); return q }

// Consistency sets the consistency level.
func (q *Query) Consistency(level gocql.Consistency) *Query {
	q.raw = q.raw.Consistency(level)
	return q
}

// SerialConsistency sets the serial consistency level.
func (q *Query) SerialConsistency(level gocql.Consistency) *Query {
	q.raw = q.raw.SerialConsistency(level)
	return q
}

// PageSize sets the page size.
func (q *Query) PageSize(n int) *Query { q.raw = q.raw.PageSize(n); return q }

// PageState resumes a paged read.
func (q *Query) PageState(state []byte) *Query { q.raw = q.raw.PageState(state); return q }

// Prefetch sets when the next page is fetched.
func (q *Query) Prefetch(p float64) *Query { q.raw = q.raw.Prefetch(p); return q }

// WithTimestamp sets the write timestamp in microseconds.
func (q *Query) WithTimestamp(timestamp int64) *Query {
	q.raw = q.raw.WithTimestamp(timestamp)
	return q
}

// DefaultTimestamp turns the client-side timestamp on or off.
func (q *Query) DefaultTimestamp(enable bool) *Query {
	q.raw = q.raw.DefaultTimestamp(enable)
	return q
}

// Idempotent marks the query idempotent for the retry and speculative policies.
func (q *Query) Idempotent(value bool) *Query { q.raw = q.raw.Idempotent(value); return q }

// RetryPolicy sets the retry policy.
func (q *Query) RetryPolicy(policy gocql.RetryPolicy) *Query {
	q.raw = q.raw.RetryPolicy(policy)
	return q
}

// RoutingKey sets the routing key.
func (q *Query) RoutingKey(key []byte) *Query { q.raw = q.raw.RoutingKey(key); return q }

// NoSkipMetadata asks the server to return result metadata with every page.
func (q *Query) NoSkipMetadata() *Query { q.raw = q.raw.NoSkipMetadata(); return q }

// SetKeyspace sets the keyspace the query runs against.
func (q *Query) SetKeyspace(keyspace string) *Query { q.raw = q.raw.SetKeyspace(keyspace); return q }

// run guards the query, sends it with send and logs it.
func (q *Query) run(ctx context.Context, send func() error) error {
	c, err := begin(ctx, q.raw.Statement(), q.raw.Keyspace())
	if err != nil {
		return err
	}
	failure := send()
	c.finish(ctx, failure)
	return failure
}

// Exec executes the query without returning rows.
func (q *Query) Exec() error { return q.ExecContext(q.raw.Context()) }

// ExecContext executes the query with ctx, without returning rows.
func (q *Query) ExecContext(ctx context.Context) error {
	return q.run(ctx, func() error { return q.raw.ExecContext(ctx) })
}

// Scan executes the query and scans the first row into dest.
func (q *Query) Scan(dest ...any) error { return q.ScanContext(q.raw.Context(), dest...) }

// ScanContext is Scan with ctx.
func (q *Query) ScanContext(ctx context.Context, dest ...any) error {
	return q.run(ctx, func() error { return q.raw.ScanContext(ctx, dest...) })
}

// MapScan executes the query and scans the first row into m.
func (q *Query) MapScan(m map[string]any) error { return q.MapScanContext(q.raw.Context(), m) }

// MapScanContext is MapScan with ctx.
func (q *Query) MapScanContext(ctx context.Context, m map[string]any) error {
	return q.run(ctx, func() error { return q.raw.MapScanContext(ctx, m) })
}

// ScanCAS executes a lightweight transaction and scans its result.
func (q *Query) ScanCAS(dest ...any) (applied bool, err error) {
	return q.ScanCASContext(q.raw.Context(), dest...)
}

// ScanCASContext is ScanCAS with ctx.
func (q *Query) ScanCASContext(ctx context.Context, dest ...any) (applied bool, err error) {
	err = q.run(ctx, func() (failure error) { applied, failure = q.raw.ScanCASContext(ctx, dest...); return failure })
	return applied, err
}

// MapScanCAS is ScanCAS scanning into a map.
func (q *Query) MapScanCAS(dest map[string]any) (applied bool, err error) {
	return q.MapScanCASContext(q.raw.Context(), dest)
}

// MapScanCASContext is MapScanCAS with ctx.
func (q *Query) MapScanCASContext(ctx context.Context, dest map[string]any) (applied bool, err error) {
	err = q.run(ctx, func() (failure error) { applied, failure = q.raw.MapScanCASContext(ctx, dest); return failure })
	return applied, err
}

// Iter executes the query and returns an iterator over its rows. A refused write
// returns an iterator whose Close returns the refusal.
func (q *Query) Iter() *Iter { return q.IterContext(q.raw.Context()) }

// IterContext is Iter with ctx. The iterator pages through the same statement, so
// fetching later pages is a read of what the guard already allowed.
func (q *Query) IterContext(ctx context.Context) *Iter {
	c, err := begin(ctx, q.raw.Statement(), q.raw.Keyspace())
	if err != nil {
		return &Iter{err: err}
	}
	iter := q.raw.IterContext(ctx)
	c.finish(ctx, nil)
	return &Iter{raw: iter}
}

// Iter is the rows of a guarded query. It has gocql.Iter's reading methods. When
// the guard refused the statement it holds no rows and Close returns the refusal.
type Iter struct {
	raw *gocql.Iter
	err error
}

// Scan reads the next row into dest; it returns false at the end or after a failure.
func (i *Iter) Scan(dest ...any) bool { return i.raw != nil && i.raw.Scan(dest...) }

// MapScan reads the next row into m.
func (i *Iter) MapScan(m map[string]any) bool { return i.raw != nil && i.raw.MapScan(m) }

// Close releases the iterator and returns the first error: the guard's refusal or the driver's.
func (i *Iter) Close() error {
	if i.raw == nil {
		return i.err
	}
	return i.raw.Close()
}

// NumRows returns the number of rows in the current page.
func (i *Iter) NumRows() int {
	if i.raw == nil {
		return 0
	}
	return i.raw.NumRows()
}

// Columns describes the result columns.
func (i *Iter) Columns() []gocql.ColumnInfo {
	if i.raw == nil {
		return nil
	}
	return i.raw.Columns()
}

// PageState returns the state to resume the read after the current page.
func (i *Iter) PageState() []byte {
	if i.raw == nil {
		return nil
	}
	return i.raw.PageState()
}

// WillSwitchPage reports whether the next row is on another page.
func (i *Iter) WillSwitchPage() bool { return i.raw != nil && i.raw.WillSwitchPage() }

// Scanner returns a database/sql-style scanner over the rows.
func (i *Iter) Scanner() gocql.Scanner {
	if i.raw == nil {
		return failedScanner{err: i.err}
	}
	return i.raw.Scanner()
}

// failedScanner is the scanner of a refused query: no rows, and the refusal as its error.
type failedScanner struct{ err error }

func (failedScanner) Next() bool          { return false }
func (s failedScanner) Scan(...any) error { return s.err }
func (s failedScanner) Err() error        { return s.err }

// Batch is a guarded gocql batch. Every batch is a write.
type Batch struct{ raw *gocql.Batch }

// Query adds a statement to the batch.
func (b *Batch) Query(stmt string, args ...any) *Batch { b.raw = b.raw.Query(stmt, args...); return b }

// Bind adds a statement whose values come from binder.
func (b *Batch) Bind(stmt string, binder func(q *gocql.QueryInfo) ([]any, error)) {
	b.raw.Bind(stmt, binder)
}

// Size returns the number of statements in the batch.
func (b *Batch) Size() int { return b.raw.Size() }

// WithContext sets the context that governs the batch and attributes it to its
// request. Pass r.Context().
func (b *Batch) WithContext(ctx context.Context) *Batch { return &Batch{raw: b.raw.WithContext(ctx)} }

// Consistency sets the consistency level.
func (b *Batch) Consistency(level gocql.Consistency) *Batch {
	b.raw = b.raw.Consistency(level)
	return b
}

// SerialConsistency sets the serial consistency level.
func (b *Batch) SerialConsistency(level gocql.Consistency) *Batch {
	b.raw = b.raw.SerialConsistency(level)
	return b
}

// WithTimestamp sets the write timestamp in microseconds.
func (b *Batch) WithTimestamp(timestamp int64) *Batch {
	b.raw = b.raw.WithTimestamp(timestamp)
	return b
}

// DefaultTimestamp turns the client-side timestamp on or off.
func (b *Batch) DefaultTimestamp(enable bool) *Batch {
	b.raw = b.raw.DefaultTimestamp(enable)
	return b
}

// RetryPolicy sets the retry policy.
func (b *Batch) RetryPolicy(policy gocql.RetryPolicy) *Batch {
	b.raw = b.raw.RetryPolicy(policy)
	return b
}

// SetKeyspace sets the keyspace the batch runs against.
func (b *Batch) SetKeyspace(keyspace string) *Batch { b.raw = b.raw.SetKeyspace(keyspace); return b }

// begin refuses the batch in a Preview. When it is sent (outside a Preview) its
// Db entry reads BEGIN BATCH <statement>; …; APPLY BATCH.
func (b *Batch) begin(ctx context.Context) (*call, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := sendproof.Guard(ctx, system, "BATCH", true, ""); err != nil {
		return nil, err
	}
	parts := make([]string, 0, len(b.raw.Entries))
	keyspace, table := "", ""
	for _, entry := range b.raw.Entries {
		parts = append(parts, stores.SanitizeLiterals(entry.Stmt, false))
		if table == "" {
			keyspace, table = stores.CQLTarget(entry.Stmt)
		}
	}
	if keyspace == "" {
		keyspace = b.raw.Keyspace()
	}
	statement := "BEGIN BATCH " + strings.Join(parts, "; ") + "; APPLY BATCH"
	return &call{decision: stores.Decision{Kind: stores.Write, Operation: "BATCH"}, statement: statement, keyspace: keyspace, table: table, started: time.Now()}, nil
}

func (b *Batch) run(ctx context.Context, send func() error) error {
	c, err := b.begin(ctx)
	if err != nil {
		return err
	}
	failure := send()
	c.finish(ctx, failure)
	return failure
}

// Exec executes the batch.
func (b *Batch) Exec() error { return b.ExecContext(b.raw.Context()) }

// ExecContext executes the batch with ctx.
func (b *Batch) ExecContext(ctx context.Context) error {
	return b.run(ctx, func() error { return b.raw.ExecContext(ctx) })
}

// ExecCAS executes the batch with lightweight transactions.
func (b *Batch) ExecCAS(dest ...any) (bool, *gocql.Iter, error) {
	return b.ExecCASContext(b.raw.Context(), dest...)
}

// ExecCASContext is ExecCAS with ctx.
func (b *Batch) ExecCASContext(ctx context.Context, dest ...any) (applied bool, iter *gocql.Iter, err error) {
	err = b.run(ctx, func() (failure error) { applied, iter, failure = b.raw.ExecCASContext(ctx, dest...); return failure })
	return applied, iter, err
}

// MapExecCAS is ExecCAS scanning into a map.
func (b *Batch) MapExecCAS(dest map[string]any) (bool, *gocql.Iter, error) {
	return b.MapExecCASContext(b.raw.Context(), dest)
}

// MapExecCASContext is MapExecCAS with ctx.
func (b *Batch) MapExecCASContext(ctx context.Context, dest map[string]any) (applied bool, iter *gocql.Iter, err error) {
	err = b.run(ctx, func() (failure error) { applied, iter, failure = b.raw.MapExecCASContext(ctx, dest); return failure })
	return applied, iter, err
}

// Iter executes the batch and returns its iterator. A refused batch returns an
// iterator whose Close returns the refusal.
func (b *Batch) Iter() *Iter { return b.IterContext(b.raw.Context()) }

// IterContext is Iter with ctx.
func (b *Batch) IterContext(ctx context.Context) *Iter {
	c, err := b.begin(ctx)
	if err != nil {
		return &Iter{err: err}
	}
	iter := b.raw.IterContext(ctx)
	c.finish(ctx, nil)
	return &Iter{raw: iter}
}
