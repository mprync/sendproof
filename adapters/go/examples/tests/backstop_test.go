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

// belowGuard is a statement the preview guard reads as a harmless query, which
// the wrapped driver below it sends as COMMIT: a commit the guard can't see.
const belowGuard = "SELECT 'commit below the guard'"

// TestACommitBelowTheGuardNeverConfirms covers the start-savepoint backstop of
// spec/data-stores.md on every server dialect: whatever ends the preview
// transaction out of the guard's sight erases sendproof_preview (on SQL Server
// drops @@TRANCOUNT to 0), so the preview answers 500 instead of confirming.
// SQLite is left out: its commit hook already turns every commit into a rollback,
// and the hook needs the real driver connection, which the wrapper hides.
func TestACommitBelowTheGuardNeverConfirms(t *testing.T) {
	eachEngine(t, func(t *testing.T, e engine, _ *sql.DB) {
		if e.name == "sqlite" {
			t.Skip("the SQLite commit hook already refuses every commit")
		}
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
		db := newItems(t, e, pool)
		handler := app(t, db, func(w http.ResponseWriter, r *http.Request) {
			if _, err := db.ExecContext(r.Context(), "INSERT INTO items (id, name) VALUES ('kept', 'Preview')"); err != nil {
				t.Errorf("insert: %v", err)
			}
			_, _ = db.ExecContext(r.Context(), belowGuard)
			w.WriteHeader(201)
		})
		if status, envelope := preview(t, handler, "/run"); status != 500 || envelope["rolledBack"] == true {
			t.Fatalf("a preview committed below the guard was confirmed: %d %v", status, envelope)
		}
		// The commit is real: the backstop can only refuse to confirm it.
		exec(t, pool, "DELETE FROM items")
	})
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

// commitBelow wraps a connector so its connections send belowGuard as COMMIT.
type commitBelow struct{ driver.Connector }

func (c commitBelow) Connect(ctx context.Context) (driver.Conn, error) {
	conn, err := c.Connector.Connect(ctx)
	if err != nil {
		return nil, err
	}
	return &rewriting{conn}, nil
}

// rewriting forwards every optional driver interface database/sql uses, with
// belowGuard replaced by COMMIT.
type rewriting struct{ driver.Conn }

func rewrite(query string) string {
	if query == belowGuard {
		return "COMMIT"
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
