// Package dbsql connects a database/sql database to Sendproof.
//
// Wrap the application's *sql.DB with Wrap and run every query through the
// wrapper. During a preview the wrapper routes all calls of the request to one
// transaction on a dedicated connection, which Sendproof rolls back afterwards.
// During an observed send it routes them to a dedicated connection whose
// committed writes it captures. Otherwise it forwards to the pool unchanged. In
// every case it records each command, with redacted parameters, in the preview
// or trace.
//
// # Change capture
//
// No table registration is needed. Each dialect captures row changes per
// statement, in execution order, with the real before and after rows and the
// row's primary key:
//
//   - SQLite uses the pre-update hook on the dedicated connection. It sees every
//     row change, including triggers, foreign-key actions and REPLACE, and tables
//     without a primary key are identified by rowid. It needs a driver that
//     exposes the hook, such as modernc.org/sqlite.
//   - PostgreSQL previews use an audit table and row triggers created inside the
//     rolled-back transaction, so they also see every row change. Creating the
//     triggers locks the tables against concurrent writes until the preview
//     ends. A guard trigger makes any commit of the preview transaction fail.
//   - MySQL, SQL Server, and PostgreSQL observed sends use keyed capture: locking
//     reads by primary key around each single-table INSERT, REPLACE, UPDATE or
//     DELETE. Changes made by triggers and foreign-key actions, statements of
//     other shapes and tables without a primary key are not read; the capture is
//     then marked incomplete and the trace explains why.
//
// The capture connection serves only the request, so writes by concurrent
// requests never appear. Observed sends run each autocommit statement in a
// transaction of its own, the equivalent of autocommit, so its reads are isolated
// too. The exception, a write that returns rows outside a transaction under keyed
// capture, is labeled in the trace. Updates that leave a row unchanged are not
// reported. Handles that bypass the wrapper are neither rolled back nor shown.
//
// # Preview safety
//
// A preview refuses statements that could end its transaction: COMMIT, ROLLBACK
// and BEGIN, MySQL statements that commit implicitly and procedure calls on
// MySQL and SQL Server. The refused call returns ErrUnsafeStatement, and the
// whole preview then fails instead of being confirmed, even if the handler
// ignores the error. Application transactions still work through BeginTx,
// which runs them on savepoints. SQLite's commit hook and PostgreSQL's guard
// trigger turn any commit that slips through into a rollback, and MySQL and SQL
// Server previews stop when the database ends the transaction after an error.
//
// A PostgreSQL preview runs each statement that is outside an application
// transaction on a savepoint, so a failed statement is undone on its own, as with
// autocommit, instead of aborting the rest of the preview.
package dbsql

import (
	"context"
	"database/sql"
	"errors"
	"sync"
	"time"

	"github.com/mprync/sendproof/adapters/go/sendproof"
)

// Querier is implemented by *DB and *Tx. Handlers can accept it to run the same
// code inside or outside an explicit transaction.
type Querier interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

var (
	_ Querier = (*DB)(nil)
	_ Querier = (*Tx)(nil)
)

// DB wraps a *sql.DB. Create it with Wrap. It is safe for concurrent use.
type DB struct {
	pool    *sql.DB
	cfg     config
	dialect Dialect
	// previews lets one MySQL preview run at a time; it is nil for other
	// dialects. See previewQueue for why MySQL previews take turns.
	previews previewQueue
}

// Wrap returns a DB that enlists in Sendproof previews. The dialect is detected
// from the pool's driver unless WithDialect names it.
func Wrap(pool *sql.DB, options ...Option) (*DB, error) {
	if pool == nil {
		return nil, errors.New("dbsql: the database must not be nil")
	}
	var cfg config
	for _, option := range options {
		if err := option(&cfg); err != nil {
			return nil, err
		}
	}
	dialect := cfg.dialect
	if dialect == DialectAuto {
		var err error
		if dialect, err = detectDialect(pool); err != nil {
			return nil, err
		}
	}
	db := &DB{pool: pool, cfg: cfg, dialect: dialect}
	if dialect == DialectMySQL {
		db.previews = make(previewQueue, 1)
	}
	return db, nil
}

// previewQueue holds a token while a MySQL preview runs, so previews through one
// DB take turns, as SQLite previews do behind BEGIN IMMEDIATE.
//
// InnoDB checks a new key for duplicates under a shared lock. When three or more
// transactions insert the same key and the first one rolls back, as every
// preview does, the waiters each hold that shared lock and each need the
// exclusive one, so InnoDB aborts all but one with a deadlock (error 1213). A
// committed insert gives them a duplicate-key error instead, so concurrent
// previews would fail where the same requests sent for real would not. Taking
// turns keeps them from waiting on one another's rolled-back rows.
type previewQueue chan struct{}

// acquire waits for this preview's turn, or for ctx to end. A nil queue lets
// every preview run at once.
func (q previewQueue) acquire(ctx context.Context) error {
	if q == nil {
		return nil
	}
	select {
	case q <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// release ends the turn taken by acquire.
func (q previewQueue) release() {
	if q != nil {
		<-q
	}
}

// Unwrap returns the underlying pool. Calls made on it bypass Sendproof.
func (d *DB) Unwrap() *sql.DB { return d.pool }

// Dialect returns the database engine the wrapper captures changes for.
func (d *DB) Dialect() Dialect { return d.dialect }

// Provider returns the Sendproof provider for this database. Register it with
// sendproof.WithProvider.
func (d *DB) Provider() sendproof.ObservingProvider { return &provider{db: d} }

// conn is the common surface of *sql.DB, *sql.Conn and *sql.Tx.
type conn interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	PrepareContext(ctx context.Context, query string) (*sql.Stmt, error)
}

// route picks where a call runs: the capture scope of a preview or observed
// send, or the pool. It fails closed during a preview without a session.
func (d *DB) route(ctx context.Context) (*scope, conn, error) {
	active, err := sendproof.PreviewSession(ctx)
	if err != nil {
		return nil, nil, err
	}
	if active != nil {
		ours, ok := ownSession(active)
		if !ok || ours.scope.db != d {
			return nil, nil, sendproof.ErrNoPreviewSession
		}
		target, _ := ours.scope.target(ctx)
		return ours.scope, target, nil
	}
	if observed, ok := sendproof.SendObservation(ctx).(*observation); ok && observed.scope.db == d {
		target, captured := observed.scope.target(ctx)
		if captured {
			return observed.scope, target, nil
		}
		return nil, target, nil
	}
	return nil, d.pool, nil
}

// ExecContext executes a statement, inside the preview transaction during a preview.
func (d *DB) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	s, target, err := d.route(ctx)
	if err != nil {
		return nil, err
	}
	started := time.Now()
	var result sql.Result
	if s != nil {
		result, err = s.exec(ctx, target, false, query, args)
	} else {
		result, err = target.ExecContext(ctx, query, d.driverArgs(args)...)
	}
	recordExec(ctx, query, args, started, result, err)
	return result, err
}

// QueryContext runs a query, inside the preview transaction during a preview.
func (d *DB) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	s, target, err := d.route(ctx)
	if err != nil {
		return nil, err
	}
	started := time.Now()
	var rows *sql.Rows
	if s != nil {
		rows, err = s.query(ctx, target, false, query, args)
	} else {
		rows, err = target.QueryContext(ctx, query, d.driverArgs(args)...)
	}
	recordQuery(ctx, query, args, started, err)
	return rows, err
}

// QueryRowContext runs a single-row query, inside the preview transaction during
// a preview. When the call cannot run, the row's Scan reports the error.
func (d *DB) QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row {
	s, target, err := d.route(ctx)
	if err != nil {
		recordQuery(ctx, query, args, time.Now(), err)
		return d.failedRow(err)
	}
	started := time.Now()
	var row *sql.Row
	if s != nil {
		row = s.queryRow(ctx, target, false, query, args)
	} else {
		row = target.QueryRowContext(ctx, query, d.driverArgs(args)...)
	}
	recordQuery(ctx, query, args, started, row.Err())
	return row
}

// PrepareContext prepares a statement on the preview transaction, the observed
// connection or the pool. Statements bypass command recording but share the
// transaction. Keyed capture cannot read their writes.
func (d *DB) PrepareContext(ctx context.Context, query string) (*sql.Stmt, error) {
	s, target, err := d.route(ctx)
	if err != nil {
		return nil, err
	}
	if s != nil {
		return s.prepare(ctx, target, query)
	}
	return target.PrepareContext(ctx, query)
}

// BeginTx starts a transaction. During a preview it returns a nested transaction
// on a savepoint, so the application's own Commit and Rollback calls behave as
// usual while the outer preview transaction still rolls everything back. During
// an observed send it is a real transaction on the observed connection, and its
// changes count once it commits.
func (d *DB) BeginTx(ctx context.Context, options *sql.TxOptions) (*Tx, error) {
	s, target, err := d.route(ctx)
	if err != nil {
		return nil, err
	}
	if s == nil {
		begun, err := target.(interface {
			BeginTx(context.Context, *sql.TxOptions) (*sql.Tx, error)
		}).BeginTx(ctx, options)
		if err != nil {
			return nil, err
		}
		return &Tx{db: d, tx: begun}, nil
	}
	begun, savepoint, err := s.beginApp(ctx, options)
	if err != nil {
		return nil, err
	}
	return &Tx{db: d, scope: s, tx: begun, savepoint: savepoint, ctx: context.WithoutCancel(ctx)}, nil
}

// Tx is a transaction started with BeginTx. During a preview it is a savepoint.
type Tx struct {
	db        *DB
	scope     *scope  // the capture the transaction belongs to, if any
	tx        *sql.Tx // the real transaction, unless it is a preview savepoint
	savepoint string
	ctx       context.Context

	mu   sync.Mutex
	done bool
}

func (t *Tx) target() conn {
	if t.tx != nil {
		return t.tx
	}
	return t.scope.tx
}

// ExecContext executes a statement in the transaction.
func (t *Tx) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	started := time.Now()
	var result sql.Result
	var err error
	if t.scope != nil {
		result, err = t.scope.exec(ctx, t.target(), true, query, args)
	} else {
		result, err = t.tx.ExecContext(ctx, query, t.db.driverArgs(args)...)
	}
	recordExec(ctx, query, args, started, result, err)
	return result, err
}

// QueryContext runs a query in the transaction.
func (t *Tx) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	started := time.Now()
	var rows *sql.Rows
	var err error
	if t.scope != nil {
		rows, err = t.scope.query(ctx, t.target(), true, query, args)
	} else {
		rows, err = t.tx.QueryContext(ctx, query, t.db.driverArgs(args)...)
	}
	recordQuery(ctx, query, args, started, err)
	return rows, err
}

// QueryRowContext runs a single-row query in the transaction.
func (t *Tx) QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row {
	started := time.Now()
	var row *sql.Row
	if t.scope != nil {
		row = t.scope.queryRow(ctx, t.target(), true, query, args)
	} else {
		row = t.tx.QueryRowContext(ctx, query, t.db.driverArgs(args)...)
	}
	recordQuery(ctx, query, args, started, row.Err())
	return row
}

// PrepareContext prepares a statement in the transaction.
func (t *Tx) PrepareContext(ctx context.Context, query string) (*sql.Stmt, error) {
	if t.scope != nil {
		return t.scope.prepare(ctx, t.target(), query)
	}
	return t.tx.PrepareContext(ctx, query)
}

// Commit commits the transaction. During a preview it releases the savepoint, and
// the preview's rollback still discards the work.
func (t *Tx) Commit() error {
	if !t.finish() {
		return sql.ErrTxDone
	}
	if t.scope == nil {
		return t.tx.Commit()
	}
	return t.scope.endApp(t.ctx, t.tx, t.savepoint, true)
}

// Rollback aborts the transaction. During a preview it rolls back to the savepoint.
func (t *Tx) Rollback() error {
	if !t.finish() {
		return sql.ErrTxDone
	}
	if t.scope == nil {
		return t.tx.Rollback()
	}
	return t.scope.endApp(t.ctx, t.tx, t.savepoint, false)
}

func (t *Tx) finish() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.done {
		return false
	}
	t.done = true
	return true
}

func recordExec(ctx context.Context, text string, args []any, started time.Time, result sql.Result, err error) {
	call := sendproof.SQLCall{Text: text, Args: sqlArgs(args), Duration: time.Since(started), RowsAffected: -1, Category: category, Err: err}
	if err == nil && result != nil {
		if affected, affectedErr := result.RowsAffected(); affectedErr == nil {
			call.RowsAffected = affected
		}
	}
	sendproof.RecordSQL(ctx, call)
}

func recordQuery(ctx context.Context, text string, args []any, started time.Time, err error) {
	sendproof.RecordSQL(ctx, sendproof.SQLCall{Text: text, Args: sqlArgs(args), Duration: time.Since(started), RowsAffected: -1, Category: category, Err: err})
}

// failedRow returns a *sql.Row whose Scan reports that the call could not run.
// A sql.Row cannot be built directly, so it uses a cancelled context, which
// database/sql reports before it acquires a connection. The recorded command
// carries the actual cause.
func (d *DB) failedRow(error) *sql.Row {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	return d.pool.QueryRowContext(ctx, "SELECT 1")
}

const category = "database/sql"

// driverArgs prepares call arguments for the driver. Drivers without named
// parameters receive sql.NamedArg values positionally; the name still drives
// redaction in the journal.
func (d *DB) driverArgs(args []any) []any {
	if d.dialect.namedArgs() {
		return args
	}
	var converted []any
	for index, arg := range args {
		if named, ok := arg.(sql.NamedArg); ok {
			if converted == nil {
				converted = append([]any(nil), args...)
			}
			converted[index] = named.Value
		}
	}
	if converted == nil {
		return args
	}
	return converted
}

// sqlArgs converts call arguments, unwrapping sql.NamedArg, for the capture journal.
func sqlArgs(args []any) []sendproof.SQLArg {
	converted := make([]sendproof.SQLArg, len(args))
	for index, arg := range args {
		if named, ok := arg.(sql.NamedArg); ok {
			converted[index] = sendproof.SQLArg{Name: named.Name, Value: named.Value}
			continue
		}
		converted[index] = sendproof.SQLArg{Value: arg}
	}
	return converted
}
