package tests

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"net/http"
	"os"
	"testing"

	"github.com/mprync/sendproof/adapters/go/examples/fixture"
)

// Statements the preview guard reads as harmless queries, which the wrapped
// driver below it sends as something else the guard can't see.
const (
	commitBelowGuard         = "SELECT 'commit below the guard'"
	implicitCommitBelowGuard = "SELECT 'commit under implicit transactions below the guard'"
	implicitOffBelowGuard    = "SELECT 'implicit transactions off below the guard'"
)

// belowGuard maps each statement above to what the driver really sends.
var belowGuard = map[string]string{
	commitBelowGuard: "COMMIT",
	// One batch: go-mssqldb refuses statements on a transaction it saw end, but
	// the INSERT opens a new one implicitly before the batch returns.
	implicitCommitBelowGuard: "SET IMPLICIT_TRANSACTIONS ON; COMMIT; INSERT INTO items (id, name) VALUES ('after', 'Preview')",
	implicitOffBelowGuard:    "SET IMPLICIT_TRANSACTIONS OFF",
}

// TestACommitBelowTheGuardNeverConfirms covers the start-savepoint backstop of
// spec/data-stores.md on every server dialect: whatever ends the preview
// transaction out of the guard's sight erases sendproof_preview, so the preview
// answers 500 instead of confirming. SQLite is left out: its commit hook already
// turns every commit into a rollback, and the hook needs the real driver
// connection, which the wrapper hides.
func TestACommitBelowTheGuardNeverConfirms(t *testing.T) {
	eachEngine(t, func(t *testing.T, e engine, _ *sql.DB) {
		if e.name == "sqlite" {
			t.Skip("the SQLite commit hook already refuses every commit")
		}
		pool := belowGuardPool(t, e)
		db := newItems(t, e, pool)
		handler := app(t, db, func(w http.ResponseWriter, r *http.Request) {
			if _, err := db.ExecContext(r.Context(), "INSERT INTO items (id, name) VALUES ('kept', 'Preview')"); err != nil {
				t.Errorf("insert: %v", err)
			}
			_, _ = db.ExecContext(r.Context(), commitBelowGuard)
			w.WriteHeader(201)
		})
		if status, envelope := preview(t, handler, "/run"); status != 500 || envelope["rolledBack"] == true {
			t.Fatalf("a preview committed below the guard was confirmed: %d %v", status, envelope)
		}
		// The commit is real: the backstop can only refuse to confirm it.
		exec(t, pool, "DELETE FROM items")
	})
}

// TestACommitUnderImplicitTransactionsNeverConfirms covers SQL Server with
// IMPLICIT_TRANSACTIONS ON: the statement after a commit opens a new
// transaction, so @@TRANCOUNT reads 1 again and only the savepoint set when the
// preview started shows the commit.
func TestACommitUnderImplicitTransactionsNeverConfirms(t *testing.T) {
	eachEngine(t, func(t *testing.T, e engine, _ *sql.DB) {
		if e.name != "sqlserver" {
			t.Skip("IMPLICIT_TRANSACTIONS is SQL Server's")
		}
		pool := belowGuardPool(t, e)
		db := newItems(t, e, pool)
		handler := app(t, db, func(w http.ResponseWriter, r *http.Request) {
			ctx := r.Context()
			if _, err := db.ExecContext(ctx, "INSERT INTO items (id, name) VALUES ('kept', 'Preview')"); err != nil {
				t.Errorf("insert: %v", err)
			}
			if _, err := db.ExecContext(ctx, implicitCommitBelowGuard); err != nil {
				t.Errorf("commit and write again: %v", err)
			}
			// A transaction is open again, so a count of open transactions reads 1.
			var open int
			if err := db.QueryRowContext(ctx, "SELECT @@TRANCOUNT").Scan(&open); err != nil || open != 1 {
				t.Errorf("@@TRANCOUNT after the commit: %d %v", open, err)
			}
			_, _ = db.ExecContext(ctx, implicitOffBelowGuard)
			w.WriteHeader(201)
		})
		if status, envelope := preview(t, handler, "/run"); status != 500 || envelope["rolledBack"] == true {
			t.Fatalf("a preview committed under IMPLICIT_TRANSACTIONS ON was confirmed: %d %v", status, envelope)
		}
		if got := count(t, pool, "items"); got != 1 {
			t.Errorf("only the committed row stays, got %d rows", got)
		}
		exec(t, pool, "DELETE FROM items")
	})
}

// belowGuardPool opens a fresh database through a driver that rewrites the
// belowGuard statements.
func belowGuardPool(t *testing.T, e engine) *sql.DB {
	t.Helper()
	name, dsn, err := fixture.DataSource(fixture.Database{Engine: e.name, URL: freshDatabase(t, e, os.Getenv(e.variable))})
	if err != nil {
		t.Fatal(err)
	}
	opened, err := sql.Open(name, dsn)
	if err != nil {
		t.Fatal(err)
	}
	connector, err := opened.Driver().(driver.DriverContext).OpenConnector(dsn)
	if err != nil {
		t.Fatal(err)
	}
	opened.Close()
	pool := sql.OpenDB(commitBelow{connector})
	t.Cleanup(func() { pool.Close() })
	return pool
}

// TestAHandlerConflictStillConfirms checks the backstop leaves ordinary handler
// errors alone: a unique violation aborts a PostgreSQL transaction, and the
// preview still answers with the handler's 409 and a confirmed rollback.
func TestAHandlerConflictStillConfirms(t *testing.T) {
	eachEngine(t, func(t *testing.T, e engine, pool *sql.DB) {
		db := newItems(t, e, pool)
		handler := app(t, db, func(w http.ResponseWriter, r *http.Request) {
			_, _ = db.ExecContext(r.Context(), "INSERT INTO items (id, name) VALUES ('dup', 'First')")
			if _, err := db.ExecContext(r.Context(), "INSERT INTO items (id, name) VALUES ('dup', 'Second')"); err == nil {
				t.Error("the duplicate insert succeeded")
			}
			w.WriteHeader(409)
		})
		if status, envelope := preview(t, handler, "/run"); status != 200 || envelope["status"] != float64(409) || envelope["rolledBack"] != true {
			t.Fatalf("a 409 after a unique violation: %d %v", status, envelope)
		}
		if count(t, pool, "items") != 0 {
			t.Error("the preview left rows behind")
		}
	})
}

// commitBelow wraps a connector so its connections rewrite the belowGuard statements.
type commitBelow struct{ driver.Connector }

func (c commitBelow) Connect(ctx context.Context) (driver.Conn, error) {
	conn, err := c.Connector.Connect(ctx)
	if err != nil {
		return nil, err
	}
	return &rewriting{conn}, nil
}

// rewriting forwards every optional driver interface database/sql uses, with
// the belowGuard statements rewritten.
type rewriting struct{ driver.Conn }

func rewrite(query string) string {
	if sent, ok := belowGuard[query]; ok {
		return sent
	}
	return query
}

func (r *rewriting) PrepareContext(ctx context.Context, query string) (driver.Stmt, error) {
	if prepare, ok := r.Conn.(driver.ConnPrepareContext); ok {
		return prepare.PrepareContext(ctx, rewrite(query))
	}
	return r.Conn.Prepare(rewrite(query))
}

func (r *rewriting) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	if execer, ok := r.Conn.(driver.ExecerContext); ok {
		return execer.ExecContext(ctx, rewrite(query), args)
	}
	return nil, driver.ErrSkip
}

func (r *rewriting) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	if queryer, ok := r.Conn.(driver.QueryerContext); ok {
		return queryer.QueryContext(ctx, rewrite(query), args)
	}
	return nil, driver.ErrSkip
}

func (r *rewriting) BeginTx(ctx context.Context, options driver.TxOptions) (driver.Tx, error) {
	if begin, ok := r.Conn.(driver.ConnBeginTx); ok {
		return begin.BeginTx(ctx, options)
	}
	return r.Conn.Begin() //nolint:staticcheck // the fallback database/sql itself uses
}

func (r *rewriting) CheckNamedValue(value *driver.NamedValue) error {
	if checker, ok := r.Conn.(driver.NamedValueChecker); ok {
		return checker.CheckNamedValue(value)
	}
	return driver.ErrSkip
}

func (r *rewriting) ResetSession(ctx context.Context) error {
	if resetter, ok := r.Conn.(driver.SessionResetter); ok {
		return resetter.ResetSession(ctx)
	}
	return nil
}

func (r *rewriting) IsValid() bool {
	if validator, ok := r.Conn.(driver.Validator); ok {
		return validator.IsValid()
	}
	return true
}
