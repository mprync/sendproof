package dbsql

import (
	"context"
	"crypto/rand"
	"database/sql"
	"database/sql/driver"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/mprync/sendproof/adapters/go/sendproof"
)

// scope is the capture state of one previewed or observed request. It owns a
// dedicated connection, so the request's statements, and only those, run where
// the capture mechanism watches. A preview also owns the transaction on it.
type scope struct {
	db      *DB
	dialect Dialect
	preview bool
	conn    *sql.Conn
	tx      *sql.Tx // the preview transaction

	// mu serializes the request's statements so events stay in statement order.
	mu       sync.Mutex
	journal  journal
	metadata map[string]*tableMeta
	hooks    bool
	// deferred is a keyed read waiting until the rows of a write that returned
	// rows have been consumed.
	deferred *deferredRead
	// depth counts the application's open transactions: savepoints in a preview,
	// a real transaction in an observed send.
	depth int
	// savepoints names the open savepoints of the application, outermost first.
	savepoints []string
	// rawTx reports that an observed send began a transaction with SQL text.
	rawTx bool
	// pgStatement reports a PostgreSQL statement savepoint awaiting release.
	pgStatement bool
	// sentinel is the MySQL temporary table that proves the preview transaction
	// is still open.
	sentinel string
	counter  int

	// failure is set when the preview transaction ended early or tried to commit.
	failure   atomic.Pointer[error]
	finishing atomic.Bool

	warnings []string
	warned   map[string]bool
	// logContext is a statement context of the request, whose trace still
	// records when the provider finishes with a context of its own.
	logContext  context.Context
	closed      bool
	held        bool
	cancel      context.CancelFunc
	busyTimeout *int
	statements  []*sql.Stmt
	blind       bool
	// queued reports that this preview holds its DB's preview turn, which
	// release hands back.
	queued bool
}

type deferredRead struct {
	statement *keyedStatement
	target    conn
	inTx      bool
}

// pgStatementSavepoint protects a PostgreSQL preview statement that runs
// outside an application transaction, so that its failure only undoes the
// statement, as autocommit would, instead of aborting the whole preview.
const pgStatementSavepoint = "sendproof_statement"

// open acquires the dedicated connection and prepares capture on it.
func (d *DB) open(ctx context.Context, preview bool) (s *scope, err error) {
	return d.openScope(ctx, preview, nil)
}

// A held transaction's BeginTx context lives until Close. The acquisition
// context still bounds all setup and is wired to that context until handoff.
func (d *DB) openScope(ctx context.Context, preview bool, lifetime context.Context) (s *scope, err error) {
	// A preview waits for its turn before it takes a connection, so waiting
	// previews never hold pool connections the application needs.
	if preview {
		if err := d.previews.acquire(ctx); err != nil {
			if lifetime != nil && errors.Is(err, context.DeadlineExceeded) {
				err = errors.Join(sendproof.ErrStoreBusy, err)
			}
			return nil, err
		}
	}
	conn, err := d.pool.Conn(ctx)
	if err != nil {
		if preview {
			d.previews.release()
		}
		return nil, err
	}
	s = &scope{db: d, dialect: d.dialect, preview: preview, conn: conn, metadata: map[string]*tableMeta{}, warned: map[string]bool{}, queued: preview}
	defer func(opened *scope) {
		if err != nil {
			err = errors.Join(err, opened.release(context.WithoutCancel(ctx)))
		}
	}(s)
	if d.dialect == DialectSQLite {
		if err := s.registerHooks(); err != nil {
			return nil, fmt.Errorf("%w: %w", err, sendproof.ErrPreviewUnavailable)
		}
	}
	if !preview {
		return s, nil
	}
	txContext := ctx
	if lifetime != nil {
		s.held = true
		txContext = lifetime
		if d.dialect == DialectSQLite {
			var busyTimeout int
			if err := conn.QueryRowContext(ctx, "PRAGMA busy_timeout").Scan(&busyTimeout); err != nil {
				return nil, err
			}
			s.busyTimeout = &busyTimeout
			if _, err := conn.ExecContext(ctx, "PRAGMA busy_timeout=0"); err != nil {
				return nil, err
			}
		}
	}
	if s.tx, err = conn.BeginTx(txContext, nil); err != nil {
		return nil, err
	}
	switch d.dialect {
	case DialectSQLite:
		if s.held {
			// Upgrade a deferred transaction to a write transaction on open,
			// even before the first step. The header change rolls back too.
			var version int
			if err := s.tx.QueryRowContext(ctx, "PRAGMA main.user_version").Scan(&version); err != nil {
				return nil, err
			}
			if _, err := s.tx.ExecContext(ctx, fmt.Sprintf("PRAGMA main.user_version=%d", version)); err != nil {
				return nil, err
			}
		}
	case DialectPostgres:
		lockTimeout := auditLockTimeout
		if s.held {
			lockTimeout = "2s"
		}
		blind, err := installAudit(ctx, s.tx, lockTimeout)
		if errors.Is(err, errLockTimeout) {
			return nil, fmt.Errorf("%w: %w", err, sendproof.ErrPreviewUnavailable)
		}
		if err != nil {
			return nil, err
		}
		if blind > 0 {
			s.blind = true
			s.journal.markIncomplete()
			s.warnings = append(s.warnings, fmt.Sprintf("%d writable tables could not be instrumented, because the database role lacks the TRIGGER privilege; their changes are not shown", blind))
		}
	case DialectMySQL:
		suffix := make([]byte, 6)
		_, _ = rand.Read(suffix)
		s.sentinel = "sendproof_sentinel_" + hex.EncodeToString(suffix)
		if _, err := s.tx.ExecContext(ctx, "CREATE TEMPORARY TABLE "+s.sentinel+" (alive INT) ENGINE=InnoDB"); err != nil {
			return nil, err
		}
		if _, err := s.tx.ExecContext(ctx, "INSERT INTO "+s.sentinel+" VALUES (1)"); err != nil {
			return nil, err
		}
	}
	// The commit backstop, on every dialect: finishPreview checks this savepoint,
	// which any commit erases. SQL Server names savepoints with SAVE TRANSACTION.
	set := "SAVEPOINT " + previewSavepoint
	if d.dialect == DialectSQLServer {
		set = "SAVE TRANSACTION " + previewSavepoint
	}
	if _, err := s.tx.ExecContext(ctx, set); err != nil {
		return nil, err
	}
	return s, nil
}

// neverCommitted is the backstop of spec/data-stores.md "Transaction-control
// statements from the handler", on every dialect. It rolls back to the savepoint
// open() set when the preview started: any commit, explicit or implicit, erases
// every savepoint, so a failure means something the guard didn't see committed
// the preview transaction, even when a new transaction opens after a commit:
// under MySQL autocommit=0, and under SQL Server IMPLICIT_TRANSACTIONS ON, where
// @@TRANCOUNT reads 1 again.
func (s *scope) neverCommitted(ctx context.Context) error {
	if s.tx == nil {
		return nil
	}
	// ROLLBACK TO, not RELEASE: it also succeeds on a PostgreSQL transaction an
	// ordinary handler error aborted, and discards any savepoint the handler left
	// open after it. The whole transaction rolls back next anyway. SQL Server
	// can't release a savepoint at all.
	rollback := "ROLLBACK TO SAVEPOINT " + previewSavepoint
	if s.dialect == DialectSQLServer {
		rollback = "ROLLBACK TRANSACTION " + previewSavepoint
	}
	if _, err := s.tx.ExecContext(ctx, rollback); err != nil {
		return fmt.Errorf("dbsql: the savepoint set when the preview started was gone, so something committed the preview transaction: %w", err)
	}
	return nil
}

// registerHooks installs the SQLite hooks on the dedicated connection.
func (s *scope) registerHooks() error {
	return s.conn.Raw(func(driverConn any) error {
		hooks, err := bindSQLiteHooks(driverConn)
		if err != nil {
			return err
		}
		hooks.register(s.onRowChange, s.onCommit, s.onRollback)
		s.hooks = true
		return nil
	})
}

func (s *scope) onRowChange(row sqliteRow) {
	if row.readFailure != nil {
		s.journal.markIncomplete()
	}
	s.journal.add(row.event())
}

// onCommit refuses every commit of a preview transaction: SQLite then rolls it
// back instead. It promotes the events of an observed send's transaction.
func (s *scope) onCommit() int32 {
	if s.preview {
		s.fail(errors.New("dbsql: the preview transaction tried to commit; SQLite rolled it back instead"))
		return 1
	}
	s.journal.commit()
	return 0
}

func (s *scope) onRollback() {
	if s.preview {
		if !s.finishing.Load() {
			s.fail(fmt.Errorf("dbsql: the preview transaction was rolled back by a statement: %w", sendproof.ErrSessionFailed))
		}
		return
	}
	s.journal.rollback()
}

func (s *scope) fail(err error) {
	s.failure.CompareAndSwap(nil, &err)
}

func (s *scope) failed() error {
	if err := s.failure.Load(); err != nil {
		return *err
	}
	return nil
}

// release returns the dedicated connection to the pool, without the hooks and
// temporary objects of the capture. A connection that cannot be cleaned is
// discarded instead.
func (s *scope) release(ctx context.Context) error {
	if s.closed {
		return nil
	}
	s.closed = true
	var errs []error
	if s.tx != nil {
		s.finishing.Store(true)
		if err := s.tx.Rollback(); err != nil && !errors.Is(err, sql.ErrTxDone) {
			errs = append(errs, err)
		}
	}
	if s.cancel != nil {
		s.cancel()
	}
	if s.sentinel != "" {
		if _, err := s.conn.ExecContext(ctx, "DROP TEMPORARY TABLE IF EXISTS "+s.sentinel); err != nil {
			errs = append(errs, err)
			_ = s.conn.Raw(func(any) error { return driver.ErrBadConn })
		}
	}
	if s.hooks {
		err := s.conn.Raw(func(driverConn any) (err error) {
			defer func() {
				if recover() != nil {
					err = driver.ErrBadConn
				}
			}()
			hooks, bindErr := bindSQLiteHooks(driverConn)
			if bindErr != nil {
				return driver.ErrBadConn
			}
			hooks.register(nil, nil, nil)
			return nil
		})
		if err != nil && !errors.Is(err, driver.ErrBadConn) {
			errs = append(errs, err)
		}
	}
	if s.busyTimeout != nil {
		if _, err := s.conn.ExecContext(ctx, fmt.Sprintf("PRAGMA busy_timeout=%d", *s.busyTimeout)); err != nil && !errors.Is(err, sql.ErrConnDone) {
			errs = append(errs, err)
			_ = s.conn.Raw(func(any) error { return driver.ErrBadConn })
		}
	}
	if err := s.conn.Close(); err != nil && !errors.Is(err, sql.ErrConnDone) {
		errs = append(errs, err)
	}
	// The transaction has ended, so its locks are gone: the next preview may run.
	if s.queued {
		s.queued = false
		s.db.previews.release()
	}
	return errors.Join(errs...)
}

// target returns where a call of the request runs and whether it belongs to the
// capture. During an observed send, statements issued outside an open
// application transaction go to the pool, as they would without Sendproof.
func (s *scope) target(ctx context.Context) (conn, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.preview {
		return s.tx, true
	}
	if s.depth > 0 {
		s.journal.markIncomplete()
		s.warnLocked(ctx, "a statement outside the open transaction ran on another connection, as it would without Sendproof, and is not captured")
		return s.db.pool, false
	}
	return s.conn, true
}

// warn records a warning in the trace once.
func (s *scope) warnLocked(ctx context.Context, message string) {
	if s.warned[message] {
		return
	}
	s.warned[message] = true
	sendproof.Log(ctx, "Warning", "Sendproof change capture: "+message+".")
}

// incomplete marks the capture as missing changes and says why.
func (s *scope) incomplete(ctx context.Context, problem string) {
	if problem == "" {
		return
	}
	s.journal.markIncomplete()
	s.warnLocked(ctx, "changes may be incomplete: "+problem)
}

// requestContext returns a context whose trace still records warnings.
func (s *scope) requestContext(ctx context.Context) context.Context {
	if s.logContext != nil {
		return s.logContext
	}
	return ctx
}

// ready runs before each statement: it refuses work after a failure, completes
// deferred work of the previous statement and logs pending warnings.
func (s *scope) ready(ctx context.Context) error {
	if s.logContext == nil && sendproof.IsCapturing(ctx) {
		s.logContext = ctx
	}
	for _, warning := range s.warnings {
		s.warnLocked(ctx, warning)
	}
	s.warnings = nil
	if err := s.failed(); err != nil {
		return err
	}
	if s.pgStatement {
		s.pgStatement = false
		if _, err := s.tx.ExecContext(ctx, "RELEASE SAVEPOINT "+pgStatementSavepoint); err != nil {
			if !abortedTransaction(err) {
				return err
			}
			if _, err := s.tx.ExecContext(ctx, "ROLLBACK TO SAVEPOINT "+pgStatementSavepoint); err != nil {
				return err
			}
			if _, err := s.tx.ExecContext(ctx, "RELEASE SAVEPOINT "+pgStatementSavepoint); err != nil {
				return err
			}
		}
	}
	if pending := s.deferred; pending != nil {
		s.deferred = nil
		events, problem, err := pending.statement.finish(ctx, pending.target, s.dialect, -1)
		if err != nil {
			s.incomplete(ctx, err.Error())
		}
		for _, event := range events {
			s.journal.add(event)
		}
		if !pending.inTx {
			s.journal.commit()
		}
		s.incomplete(ctx, problem)
	}
	return nil
}

// checkAlive verifies, after a failed statement, that the preview transaction is
// still open. MySQL rolls the whole transaction back on a deadlock and SQL
// Server on severe errors; later statements would then commit on their own.
func (s *scope) checkAlive(ctx context.Context, failure error) {
	if !s.preview || failure == nil {
		return
	}
	var alive int
	var err error
	switch s.dialect {
	case DialectMySQL:
		err = s.tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+s.sentinel).Scan(&alive)
	case DialectSQLServer:
		err = s.tx.QueryRowContext(ctx, "SELECT @@TRANCOUNT").Scan(&alive)
	default:
		return
	}
	if err != nil || alive == 0 {
		s.fail(fmt.Errorf("dbsql: the database ended the preview transaction after an error (%v): %w", failure, sendproof.ErrSessionFailed))
	}
}

// exec runs a statement that returns no rows and captures its changes.
func (s *scope) exec(ctx context.Context, target conn, inTx bool, text string, args []any) (sql.Result, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.readyHandler(ctx); err != nil {
		return nil, err
	}
	info := analyze(text, s.dialect)
	if s.preview {
		if err := previewSafeWith(text, info, s.dialect, s.db.cfg.safeProcedures); err != nil {
			s.fail(err) // a refused statement is never confirmed as a rollback
			return nil, err
		}
	}
	args = s.db.driverArgs(args)
	switch {
	case s.dialect == DialectSQLite:
		mark := s.journal.position()
		result, err := target.ExecContext(ctx, text, args...)
		s.afterHooked(info, mark, err)
		return result, err
	case s.preview && s.dialect == DialectPostgres:
		return s.execAudited(ctx, target, info, text, args)
	default:
		return s.execKeyed(ctx, target, inTx, info, text, args)
	}
}

// afterHooked follows the savepoints of a SQLite statement, or discards the
// events of a single statement that failed and was undone.
func (s *scope) afterHooked(info statementInfo, mark int, err error) {
	if err != nil {
		if len(info.statements) == 1 {
			s.journal.truncate(mark)
		} else {
			s.journal.markIncomplete()
		}
		return
	}
	for _, op := range info.savepoints {
		s.journal.savepoint(op)
	}
}

// execAudited runs a PostgreSQL preview statement, on a statement savepoint when
// it is not part of an application transaction.
func (s *scope) execAudited(ctx context.Context, target conn, info statementInfo, text string, args []any) (sql.Result, error) {
	protect := s.depth == 0 && len(info.savepoints) == 0
	if protect {
		if _, err := s.tx.ExecContext(ctx, "SAVEPOINT "+pgStatementSavepoint); err != nil {
			return nil, err
		}
	}
	result, err := target.ExecContext(ctx, text, args...)
	if protect {
		closing := []string{"RELEASE SAVEPOINT " + pgStatementSavepoint}
		if err != nil {
			closing = append([]string{"ROLLBACK TO SAVEPOINT " + pgStatementSavepoint}, closing...)
		}
		for _, statement := range closing {
			if _, closeErr := s.tx.ExecContext(ctx, statement); closeErr != nil {
				return result, errors.Join(err, closeErr)
			}
		}
	}
	return result, err
}

// execKeyed runs a statement with keyed capture.
func (s *scope) execKeyed(ctx context.Context, target conn, inTx bool, info statementInfo, text string, args []any) (sql.Result, error) {
	if len(info.savepoints) > 0 || !info.mayWrite && !info.begins && !info.ends {
		result, err := target.ExecContext(ctx, text, args...)
		if err == nil {
			for _, op := range info.savepoints {
				s.journal.savepoint(op)
			}
		}
		s.checkAlive(ctx, err)
		return result, err
	}
	if !s.preview && (info.begins || info.ends) {
		result, err := target.ExecContext(ctx, text, args...)
		if err == nil {
			switch {
			case info.begins:
				s.rawTx = true
			case info.rollsBack:
				s.rawTx = false
				s.journal.rollback()
			default:
				s.rawTx = false
				s.journal.commit()
			}
		}
		return result, err
	}
	inTx = inTx || s.preview || s.rawTx
	var source conn = target
	var own *sql.Tx
	if !inTx {
		// An observed autocommit statement runs in a transaction of its own, the
		// equivalent of autocommit, so its locking reads isolate it.
		var err error
		if own, err = s.conn.BeginTx(ctx, nil); err != nil {
			return nil, err
		}
		source = own
	}
	statement, problem := s.planKeyed(ctx, source, text, info, args, false)
	if statement == nil && s.preview && problem != "" {
		// The before-read may have failed because the database ended the transaction (a MySQL deadlock,
		// a SQL Server deadlock victim). The write must not then run outside it and commit on its own.
		s.checkAlive(ctx, errors.New(problem))
		if err := s.failed(); err != nil {
			return nil, err
		}
	}
	if statement == nil {
		if info.procedure {
			problem = "a procedure call, whose writes keyed capture cannot read"
		}
		s.incomplete(ctx, problem)
		result, err := source.ExecContext(ctx, text, args...)
		return s.settle(ctx, own, result, err)
	}
	var result sql.Result
	var err error
	switch statement.generated {
	case "returning", "output":
		var rows *sql.Rows
		if rows, err = source.QueryContext(ctx, statement.generatedSQL(s.dialect), args...); err == nil {
			var count int64
			count, err = statement.addGeneratedKeys(rows)
			result = countResult(count)
		}
	default:
		if result, err = source.ExecContext(ctx, text, args...); err == nil && statement.generated == "lastInsertId" {
			err = statement.addInsertIDs(ctx, source, result)
		}
	}
	if err != nil {
		return s.settle(ctx, own, nil, err)
	}
	affected := int64(-1)
	if count, countErr := result.RowsAffected(); countErr == nil {
		affected = count
	}
	events, problem, readErr := statement.finish(ctx, source, s.dialect, affected)
	if result, err = s.settle(ctx, own, result, nil); err != nil {
		return nil, err
	}
	if readErr != nil {
		s.incomplete(ctx, readErr.Error())
	}
	for _, event := range events {
		s.journal.add(event)
	}
	if !inTx {
		s.journal.commit()
	}
	s.incomplete(ctx, problem)
	return result, nil
}

// settle ends the statement's own transaction, if any, the way autocommit would.
func (s *scope) settle(ctx context.Context, own *sql.Tx, result sql.Result, err error) (sql.Result, error) {
	if own == nil {
		s.checkAlive(ctx, err)
		return result, err
	}
	if err != nil {
		return nil, errors.Join(err, own.Rollback())
	}
	if err := own.Commit(); err != nil {
		return nil, err
	}
	return result, nil
}

// query runs a statement that returns rows and captures its changes.
func (s *scope) query(ctx context.Context, target conn, inTx bool, text string, args []any) (*sql.Rows, error) {
	var rows *sql.Rows
	err := s.withQuery(ctx, target, inTx, text, args, func(args []any) error {
		var err error
		rows, err = target.QueryContext(ctx, text, args...)
		return err
	})
	return rows, err
}

// queryRow runs a single-row statement. Its error surfaces in Scan.
func (s *scope) queryRow(ctx context.Context, target conn, inTx bool, text string, args []any) *sql.Row {
	var row *sql.Row
	err := s.withQuery(ctx, target, inTx, text, args, func(args []any) error {
		row = target.QueryRowContext(ctx, text, args...)
		return row.Err()
	})
	if row == nil {
		return s.db.failedRow(err)
	}
	return row
}

// withQuery wraps a query in the capture. Work that has to wait until the rows
// are consumed, releasing a statement savepoint or reading changed rows back,
// is deferred to the next statement or the end of the request.
func (s *scope) withQuery(ctx context.Context, target conn, inTx bool, text string, args []any, run func([]any) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.readyHandler(ctx); err != nil {
		return err
	}
	info := analyze(text, s.dialect)
	if s.preview {
		if err := previewSafeWith(text, info, s.dialect, s.db.cfg.safeProcedures); err != nil {
			s.fail(err) // a refused statement is never confirmed as a rollback
			return err
		}
	}
	args = s.db.driverArgs(args)
	switch {
	case s.dialect == DialectSQLite:
		mark := s.journal.position()
		err := run(args)
		s.afterHooked(info, mark, err)
		return err
	case s.preview && s.dialect == DialectPostgres:
		protect := s.depth == 0 && len(info.savepoints) == 0
		if protect {
			if _, err := s.tx.ExecContext(ctx, "SAVEPOINT "+pgStatementSavepoint); err != nil {
				return err
			}
		}
		err := run(args)
		if protect {
			s.pgStatement = true // released, or rolled back after a failure, before the next statement
		}
		return err
	}
	if !info.mayWrite {
		err := run(args)
		s.checkAlive(ctx, err)
		return err
	}
	inTx = inTx || s.preview || s.rawTx
	statement, problem := s.planKeyed(ctx, target, text, info, args, true)
	if statement == nil {
		s.incomplete(ctx, problem)
		err := run(args)
		s.checkAlive(ctx, err)
		return err
	}
	if !inTx {
		s.warnLocked(ctx, "a write that returns rows ran outside a transaction, so its changes are read without isolation from concurrent writers")
	}
	err := run(args)
	s.checkAlive(ctx, err)
	if err == nil {
		s.deferred = &deferredRead{statement: statement, target: target, inTx: inTx}
	}
	return err
}

// prepare prepares a statement on the capture connection. Statements executed
// through it are captured by the SQLite hook and the PostgreSQL audit, but not
// by keyed capture.
func (s *scope) prepare(ctx context.Context, target conn, text string) (*sql.Stmt, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.readyHandler(ctx); err != nil {
		return nil, err
	}
	info := analyze(text, s.dialect)
	if s.preview {
		if err := previewSafeWith(text, info, s.dialect, s.db.cfg.safeProcedures); err != nil {
			s.fail(err) // a refused statement is never confirmed as a rollback
			return nil, err
		}
	}
	if info.mayWrite && s.dialect != DialectSQLite && !(s.preview && s.dialect == DialectPostgres) {
		s.incomplete(ctx, "writes through prepared statements are not read by keyed capture")
	}
	stmt, err := target.PrepareContext(ctx, text)
	if s.held && err == nil {
		s.statements = append(s.statements, stmt)
	}
	return stmt, err
}

func (s *scope) readyHandler(ctx context.Context) error {
	if s.held && !sendproof.IsPreviewStepActive(ctx) {
		return sendproof.ErrNoPreviewSession
	}
	return s.ready(ctx)
}

// tableMeta returns the cached metadata of the statement's table.
func (s *scope) tableMeta(ctx context.Context, source rowSource, plan *dml) (*tableMeta, error) {
	id := strings.ToLower(plan.tableText)
	if meta, ok := s.metadata[id]; ok {
		return meta, nil
	}
	meta, err := loadMeta(ctx, source, s.dialect, plan.table, plan.tableText)
	if err != nil {
		return nil, err
	}
	s.metadata[id] = meta
	return meta, nil
}

// beginApp starts an application transaction: a savepoint in a preview, a real
// transaction on the capture connection in an observed send.
func (s *scope) beginApp(ctx context.Context, options *sql.TxOptions) (*sql.Tx, string, error) {
	s.mu.Lock()
	if err := s.readyHandler(ctx); err != nil {
		s.mu.Unlock()
		return nil, "", err
	}
	if !s.preview {
		defer s.mu.Unlock()
		tx, err := s.conn.BeginTx(ctx, options)
		if err == nil {
			s.depth++
		}
		return tx, "", err
	}
	s.counter++
	name := fmt.Sprintf("sendproof_sp_%d", s.counter)
	s.mu.Unlock()
	create, _, _ := s.dialect.savepointSQL(name)
	if _, err := s.exec(ctx, s.tx, true, create, nil); err != nil {
		return nil, "", err
	}
	s.mu.Lock()
	if s.held && !sendproof.IsPreviewStepActive(ctx) {
		s.mu.Unlock()
		return nil, "", sendproof.ErrNoPreviewSession
	}
	s.depth++
	s.savepoints = append(s.savepoints, strings.ToUpper(name))
	s.mu.Unlock()
	return nil, name, nil
}

// endApp ends an application transaction.
func (s *scope) endApp(ctx context.Context, tx *sql.Tx, savepoint string, commit bool) error {
	if s.held && !sendproof.IsPreviewStepActive(ctx) {
		return sql.ErrTxDone
	}
	if tx != nil {
		s.mu.Lock()
		defer s.mu.Unlock()
		readyErr := s.ready(ctx)
		var err error
		if commit && readyErr == nil {
			err = tx.Commit()
		} else {
			err = tx.Rollback()
		}
		s.depth--
		if commit && readyErr == nil && err == nil {
			s.journal.commit()
		} else {
			s.journal.rollback()
		}
		return errors.Join(readyErr, err)
	}
	_, release, rollback := s.dialect.savepointSQL(savepoint)
	var err error
	if commit {
		if release != "" {
			_, err = s.exec(ctx, s.tx, true, release, nil)
		}
	} else if _, err = s.exec(ctx, s.tx, true, rollback, nil); err == nil && release != "" {
		_, err = s.exec(ctx, s.tx, true, release, nil)
	}
	s.mu.Lock()
	if s.held && !sendproof.IsPreviewStepActive(ctx) {
		s.mu.Unlock()
		return sql.ErrTxDone
	}
	if commit && release == "" {
		s.journal.savepoint(savepointOp{kind: "release", name: strings.ToUpper(savepoint)})
	}
	s.depth--
	for index, name := range s.savepoints {
		if name == strings.ToUpper(savepoint) {
			s.savepoints = s.savepoints[:index]
			break
		}
	}
	s.mu.Unlock()
	return err
}

// finishPreview captures the preview's changes and rolls the transaction back.
func (s *scope) finishPreview(ctx context.Context) ([]sendproof.Change, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, false, nil
	}
	failure := s.failed()
	var captureErr error
	var changes []sendproof.Change
	var truncated bool
	if failure == nil {
		changes, truncated, captureErr = s.capturePreview(ctx)
	}
	// Checked even after a failure, so every path still releases the connection below.
	committed := s.neverCommitted(ctx)
	return changes, truncated, errors.Join(failure, captureErr, committed, s.release(ctx))
}

func (s *scope) capturePreview(ctx context.Context) ([]sendproof.Change, bool, error) {
	if err := s.ready(ctx); err != nil {
		return nil, false, err
	}
	switch s.dialect {
	case DialectPostgres:
		events, truncated, problems, err := readAudit(ctx, s.tx, maxEvents)
		if abortedTransaction(err) {
			// The application left its transaction failed. Production would roll it
			// back, so undo what it holds and read what remains.
			restore := pgStatementSavepoint
			if !s.pgStatement && len(s.savepoints) > 0 {
				restore = s.savepoints[0]
			}
			if _, rollbackErr := s.tx.ExecContext(ctx, "ROLLBACK TO SAVEPOINT "+restore); rollbackErr != nil {
				return nil, false, errors.Join(err, rollbackErr)
			}
			events, truncated, problems, err = readAudit(ctx, s.tx, maxEvents)
		}
		if err != nil {
			return nil, false, fmt.Errorf("dbsql: read the PostgreSQL audit: %w", err)
		}
		_, incomplete := s.journal.events(true)
		for _, problem := range problems {
			s.warnLocked(s.requestContext(ctx), problem)
		}
		return toChanges(events), truncated || incomplete, nil
	case DialectSQLite:
		events, truncated := s.journal.events(true)
		events, err := resolveSQLite(ctx, s.tx, events)
		if err != nil {
			return nil, false, err
		}
		return toChanges(events), truncated, nil
	}
	events, truncated := s.journal.events(true)
	return toChanges(events), truncated, nil
}

// finishObserved returns the committed changes of an observed send.
func (s *scope) finishObserved(ctx context.Context) ([]sendproof.Change, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ready(ctx); err != nil {
		return nil, false, err
	}
	events, truncated := s.journal.events(false)
	if s.dialect == DialectSQLite {
		var err error
		if events, err = resolveSQLite(ctx, s.conn, events); err != nil {
			return nil, false, err
		}
	}
	return toChanges(events), truncated, nil
}

func (s *scope) close(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.release(ctx)
}
