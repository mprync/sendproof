package tests

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mprync/sendproof/adapters/go/dbsql"
	"github.com/mprync/sendproof/adapters/go/sendproof"
)

// The provider tests run each scenario against SQLite and, when their servers
// are configured, PostgreSQL, MySQL and SQL Server. Every check of durable state
// reads through the plain pool, never through the preview transaction.

// newItems creates the items table and wraps the pool.
func newItems(t *testing.T, e engine, pool *sql.DB) *dbsql.DB {
	t.Helper()
	exec(t, pool, fmt.Sprintf("CREATE TABLE items (id %s PRIMARY KEY, name %s NOT NULL)", e.text, e.text))
	db, err := dbsql.Wrap(pool)
	if err != nil {
		t.Fatal(err)
	}
	return db
}

// app serves one marked route that runs body, plus an unmarked route.
func app(t *testing.T, db *dbsql.DB, body func(http.ResponseWriter, *http.Request), options ...sendproof.Option) http.Handler {
	t.Helper()
	bench, err := sendproof.New(append([]sendproof.Option{
		sendproof.WithEnvironment("Development"), sendproof.WithProvider(db.Provider()),
		sendproof.WithPrincipal(func(*http.Request) (sendproof.Principal, bool) {
			return sendproof.Principal{Subject: "dev", Scheme: "test"}, true
		}),
	}, options...)...)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	bench.HandlePreview(mux, "POST /run", http.HandlerFunc(body))
	mux.HandleFunc("POST /unmarked", body)
	return bench.Middleware(mux)
}

func preview(t *testing.T, handler http.Handler, path string) (int, map[string]any) {
	t.Helper()
	request := httptest.NewRequest("POST", "/sendproof/_preview"+path, nil)
	request.Header.Set("Prefer", "tx=rollback")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	var envelope map[string]any
	_ = json.Unmarshal(response.Body.Bytes(), &envelope)
	return response.Code, envelope
}

// observe performs an observed send and returns the stored trace.
func observe(t *testing.T, handler http.Handler, path string) (int, map[string]any) {
	t.Helper()
	request := httptest.NewRequest("POST", path, nil)
	request.Header.Set("Prefer", "trace")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	id := response.Header().Get("X-Sendproof-Trace")
	if id == "" {
		t.Fatalf("no trace for status %d: %s", response.Code, response.Body)
	}
	read := httptest.NewRecorder()
	handler.ServeHTTP(read, httptest.NewRequest("GET", "/sendproof/_api/traces/"+id, nil))
	var trace map[string]any
	_ = json.Unmarshal(read.Body.Bytes(), &trace)
	return response.Code, trace
}

func count(t *testing.T, pool *sql.DB, table string) int {
	t.Helper()
	var rows int
	if err := pool.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	return rows
}

// summary is a change as "operation key before→after" for compact comparison.
func summary(changes any) []string {
	var lines []string
	list, _ := changes.([]any)
	for _, entry := range list {
		change := entry.(map[string]any)
		key, _ := json.Marshal(change["key"])
		name := func(row any) string {
			if values, ok := row.(map[string]any); ok {
				return fmt.Sprint(values["name"])
			}
			return "-"
		}
		lines = append(lines, fmt.Sprintf("%s %s %s %s>%s", change["operation"], change["table"], key, name(change["before"]), name(change["after"])))
	}
	return lines
}

func expectChanges(t *testing.T, got any, want ...string) {
	t.Helper()
	lines := summary(got)
	if strings.Join(lines, "\n") != strings.Join(want, "\n") {
		t.Errorf("changes:\n  %s\nwant:\n  %s", strings.Join(lines, "\n  "), strings.Join(want, "\n  "))
	}
}

func logs(envelope map[string]any) string {
	encoded, _ := json.Marshal(envelope["logs"])
	return string(encoded)
}

func TestPreviewCapturesEachStatementInOrder(t *testing.T) {
	eachEngine(t, func(t *testing.T, e engine, pool *sql.DB) {
		db := newItems(t, e, pool)
		exec(t, pool, "INSERT INTO items (id, name) VALUES ('keep', 'Before')", "INSERT INTO items (id, name) VALUES ('drop', 'Gone')")
		handler := app(t, db, func(w http.ResponseWriter, r *http.Request) {
			ctx := r.Context()
			steps := []struct {
				text string
				args []any
			}{
				{"INSERT INTO items (id, name) VALUES (" + e.ph(1) + ", " + e.ph(2) + ")", []any{"new", "Added"}},
				{"UPDATE items SET name = " + e.ph(1) + " WHERE id = " + e.ph(2), []any{"After", "keep"}},
				{"DELETE FROM items WHERE id = " + e.ph(1), []any{"drop"}},
				{"UPDATE items SET name = " + e.ph(1) + " WHERE id = " + e.ph(2), []any{"Renamed", "new"}},
				{"UPDATE items SET name = name WHERE id = " + e.ph(1), []any{"keep"}}, // changes nothing
			}
			for _, step := range steps {
				if _, err := db.ExecContext(ctx, step.text, step.args...); err != nil {
					t.Errorf("%s: %v", step.text, err)
				}
			}
			var seen int
			_ = db.QueryRowContext(ctx, "SELECT COUNT(*) FROM items").Scan(&seen) // the handler reads its own writes
			w.WriteHeader(map[bool]int{true: 200, false: 500}[seen == 2])
		})
		status, envelope := preview(t, handler, "/run")
		if status != 200 || envelope["status"] != float64(200) || envelope["changesTruncated"] == true {
			t.Fatalf("status %d envelope %v", status, envelope)
		}
		expectChanges(t, envelope["changes"],
			`insert items {"id":"new"} ->Added`,
			`update items {"id":"keep"} Before>After`,
			`delete items {"id":"drop"} Gone>-`,
			`update items {"id":"new"} Added>Renamed`,
		)
		var name string
		if err := pool.QueryRow("SELECT name FROM items WHERE id = 'keep'").Scan(&name); err != nil || name != "Before" || count(t, pool, "items") != 2 {
			t.Fatalf("the preview leaked: name=%q rows=%d err=%v", name, count(t, pool, "items"), err)
		}
	})
}

func TestNestedTransactionsUseSavepoints(t *testing.T) {
	eachEngine(t, func(t *testing.T, e engine, pool *sql.DB) {
		db := newItems(t, e, pool)
		insert := "INSERT INTO items (id, name) VALUES (" + e.ph(1) + ", " + e.ph(2) + ")"
		handler := app(t, db, func(w http.ResponseWriter, r *http.Request) {
			ctx := r.Context()
			committed, err := db.BeginTx(ctx, nil)
			if err != nil {
				t.Fatal(err)
			}
			_, _ = committed.ExecContext(ctx, insert, "committed", "Yes")
			inner, _ := db.BeginTx(ctx, nil)
			_, _ = inner.ExecContext(ctx, insert, "inner", "Undone")
			_ = inner.Rollback()
			if err := committed.Commit(); err != nil {
				t.Error(err)
			}
			aborted, _ := db.BeginTx(ctx, nil)
			_, _ = aborted.ExecContext(ctx, insert, "aborted", "No")
			_ = aborted.Rollback()
		})
		status, envelope := preview(t, handler, "/run")
		if status != 200 {
			t.Fatalf("status %d: %v", status, envelope)
		}
		expectChanges(t, envelope["changes"], `insert items {"id":"committed"} ->Yes`)
		if count(t, pool, "items") != 0 {
			t.Error("the outer rollback must discard the nested commit")
		}
	})
}

func TestFailedStatementIsUndoneAlone(t *testing.T) {
	eachEngine(t, func(t *testing.T, e engine, pool *sql.DB) {
		db := newItems(t, e, pool)
		insert := "INSERT INTO items (id, name) VALUES (" + e.ph(1) + ", " + e.ph(2) + ")"
		handler := app(t, db, func(w http.ResponseWriter, r *http.Request) {
			ctx := r.Context()
			_, first := db.ExecContext(ctx, insert, "a", "First")
			_, duplicate := db.ExecContext(ctx, insert, "a", "Again")
			_, after := db.ExecContext(ctx, insert, "b", "After")
			if first != nil || duplicate == nil || after != nil {
				t.Errorf("first %v, duplicate %v, after %v: a failed statement must not abort later ones", first, duplicate, after)
			}
		})
		if status, envelope := preview(t, handler, "/run"); status != 200 {
			t.Fatalf("status %d: %v", status, envelope)
		} else {
			expectChanges(t, envelope["changes"], `insert items {"id":"a"} ->First`, `insert items {"id":"b"} ->After`)
		}
		if count(t, pool, "items") != 0 {
			t.Error("the preview leaked")
		}
	})
}

func TestTransactionControlIsRefused(t *testing.T) {
	eachEngine(t, func(t *testing.T, e engine, pool *sql.DB) {
		db := newItems(t, e, pool)
		statements := []string{"COMMIT", "ROLLBACK"}
		switch e.name {
		case "mysql":
			statements = append(statements, "BEGIN", "START TRANSACTION", "CREATE TABLE sneaky (id INT)", "CALL anything()", "SET autocommit = 1")
		case "sqlserver":
			statements = append(statements, "BEGIN TRANSACTION", "INSERT INTO items (id, name) VALUES ('x', 'y') COMMIT", "EXEC sp_who", "ROLLBACK TRANSACTION")
		default:
			statements = append(statements, "BEGIN", "END", "SELECT 1; COMMIT")
		}
		handler := app(t, db, func(w http.ResponseWriter, r *http.Request) {
			ctx := r.Context()
			_, _ = db.ExecContext(ctx, "INSERT INTO items (id, name) VALUES ('kept', 'Preview')")
			for _, statement := range statements {
				if _, err := db.ExecContext(ctx, statement); !errors.Is(err, dbsql.ErrUnsafeStatement) {
					t.Errorf("%q: got %v, want ErrUnsafeStatement", statement, err)
				}
				if _, err := db.PrepareContext(ctx, statement); !errors.Is(err, dbsql.ErrUnsafeStatement) {
					t.Errorf("prepare %q: got %v, want ErrUnsafeStatement", statement, err)
				}
			}
		})
		// The handler ignores the refusals, but a preview that tried to end its
		// transaction is never confirmed as rolled back.
		if status, envelope := preview(t, handler, "/run"); status != 500 || envelope["rolledBack"] == true {
			t.Fatalf("status %d: %v", status, envelope)
		}
		if count(t, pool, "items") != 0 {
			t.Error("a refused statement committed the preview")
		}
	})
}

func TestSecretColumnsAndSessionsAreRedacted(t *testing.T) {
	eachEngine(t, func(t *testing.T, e engine, pool *sql.DB) {
		exec(t, pool, fmt.Sprintf("CREATE TABLE creds (reset_token %s PRIMARY KEY, password_hash %s NOT NULL, name %s NOT NULL)", e.text, e.text, e.text))
		exec(t, pool, fmt.Sprintf("CREATE TABLE sessions (id %s PRIMARY KEY, data %s NOT NULL)", e.text, e.text))
		exec(t, pool, "INSERT INTO sessions (id, data) VALUES ('session-id-value', 'x')")
		db, err := dbsql.Wrap(pool)
		if err != nil {
			t.Fatal(err)
		}
		handler := app(t, db, func(w http.ResponseWriter, r *http.Request) {
			ctx := r.Context()
			var data string
			if err := db.QueryRowContext(ctx, "SELECT data FROM sessions WHERE id = "+e.ph(1), "session-id-value").Scan(&data); err != nil {
				t.Error(err)
			}
			for _, statement := range []string{
				"INSERT INTO creds (reset_token, password_hash, name) VALUES (" + e.ph(1) + ", " + e.ph(2) + ", " + e.ph(3) + ")",
			} {
				if _, err := db.ExecContext(ctx, statement, "token-value", "hash-value", "Ada"); err != nil {
					t.Error(err)
				}
			}
			if _, err := db.ExecContext(ctx, "UPDATE creds SET password_hash = "+e.ph(1)+" WHERE reset_token = "+e.ph(2), "new-hash-value", "token-value"); err != nil {
				t.Error(err)
			}
			w.WriteHeader(http.StatusNoContent)
		}, sendproof.WithSQLParameterValues(true))
		check := func(what string, result map[string]any) {
			t.Helper()
			encoded, _ := json.Marshal(result)
			for _, leaked := range []string{"token-value", "hash-value", "session-id-value"} {
				if strings.Contains(string(encoded), leaked) {
					t.Errorf("the %s leaked %q: %s", what, leaked, encoded)
				}
			}
			if !strings.Contains(string(encoded), `"name":"Ada"`) || !strings.Contains(string(encoded), "[REDACTED]") {
				t.Errorf("the %s must keep non-secret columns and redact secrets: %s", what, encoded)
			}
		}
		status, envelope := preview(t, handler, "/run")
		if status != 200 || len(envelope["changes"].([]any)) != 2 {
			t.Fatalf("status %d: %v", status, envelope)
		}
		check("preview", envelope)
		_, trace := observe(t, handler, "/run")
		check("trace", trace)
	})
}

func TestConcurrentWritersNeverAppear(t *testing.T) {
	eachEngine(t, func(t *testing.T, e engine, pool *sql.DB) {
		db := newItems(t, e, pool)
		insert := "INSERT INTO items (id, name) VALUES (" + e.ph(1) + ", " + e.ph(2) + ")"
		var writer sync.WaitGroup
		var writerErr error
		concurrent := func(id string) {
			done := make(chan struct{})
			writer.Add(1)
			go func() {
				defer writer.Done()
				defer close(done)
				ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
				defer cancel()
				_, writerErr = pool.ExecContext(ctx, insert, id, "Concurrent")
			}()
			select { // SQLite and PostgreSQL previews make the writer wait; the others let it finish
			case <-done:
			case <-time.After(300 * time.Millisecond):
			}
		}
		handler := app(t, db, func(w http.ResponseWriter, r *http.Request) {
			_, _ = db.ExecContext(r.Context(), insert, "mine", "Request")
			concurrent(strings.TrimPrefix(r.URL.Path, "/"))
			_, _ = db.ExecContext(r.Context(), "UPDATE items SET name = 'Mine' WHERE id = 'mine'")
			w.WriteHeader(http.StatusOK) // traces are announced when the handler writes its status
		})
		_, envelope := preview(t, handler, "/run")
		writer.Wait()
		expectChanges(t, envelope["changes"], `insert items {"id":"mine"} ->Request`, `update items {"id":"mine"} Request>Mine`)

		exec(t, pool, "DELETE FROM items")
		status, trace := observe(t, handler, "/run")
		writer.Wait()
		if status != 200 || writerErr != nil {
			t.Fatalf("status %d, writer %v", status, writerErr)
		}
		expectChanges(t, trace["changes"], `insert items {"id":"mine"} ->Request`, `update items {"id":"mine"} Request>Mine`)
		if count(t, pool, "items") != 2 {
			t.Errorf("the observed send and the concurrent writer must both commit")
		}
	})
}

func TestObservedSendReportsOnlyCommittedWrites(t *testing.T) {
	eachEngine(t, func(t *testing.T, e engine, pool *sql.DB) {
		db := newItems(t, e, pool)
		insert := "INSERT INTO items (id, name) VALUES (" + e.ph(1) + ", " + e.ph(2) + ")"
		handler := app(t, db, func(w http.ResponseWriter, r *http.Request) {
			ctx := r.Context()
			if _, err := db.ExecContext(ctx, insert, "autocommit", "One"); err != nil {
				t.Error(err)
			}
			kept, _ := db.BeginTx(ctx, nil)
			_, _ = kept.ExecContext(ctx, insert, "committed", "Two")
			_ = kept.Commit()
			dropped, _ := db.BeginTx(ctx, nil)
			_, _ = dropped.ExecContext(ctx, insert, "rolled-back", "Three")
			_ = dropped.Rollback()
			w.WriteHeader(http.StatusCreated)
		})
		status, trace := observe(t, handler, "/run")
		if status != 201 {
			t.Fatalf("status %d", status)
		}
		expectChanges(t, trace["changes"], `insert items {"id":"autocommit"} ->One`, `insert items {"id":"committed"} ->Two`)
		if trace["changesTruncated"] == true || count(t, pool, "items") != 2 {
			t.Errorf("trace %v, rows %d", trace, count(t, pool, "items"))
		}
	})
}

func TestGeneratedKeysIdentifyRows(t *testing.T) {
	eachEngine(t, func(t *testing.T, e engine, pool *sql.DB) {
		exec(t, pool, fmt.Sprintf("CREATE TABLE notes (%s, name %s NOT NULL)", e.autoKey, e.text))
		db, err := dbsql.Wrap(pool)
		if err != nil {
			t.Fatal(err)
		}
		handler := app(t, db, func(w http.ResponseWriter, r *http.Request) {
			ctx := r.Context()
			if _, err := db.ExecContext(ctx, "INSERT INTO notes (name) VALUES ('first'), ('second')"); err != nil {
				t.Error(err)
			}
			if _, err := db.ExecContext(ctx, "UPDATE notes SET name = 'third' WHERE name = 'second'"); err != nil {
				t.Error(err)
			}
		})
		status, envelope := preview(t, handler, "/run")
		if status != 200 {
			t.Fatalf("status %d: %v", status, envelope)
		}
		expectChanges(t, envelope["changes"],
			`insert notes {"id":1} ->first`, `insert notes {"id":2} ->second`, `update notes {"id":2} second>third`)
		if count(t, pool, "notes") != 0 {
			t.Error("the preview leaked")
		}
	})
}

func TestUpsertIsReportedAsUpdate(t *testing.T) {
	upserts := map[string]string{
		"sqlite":     "INSERT INTO items (id, name) VALUES ('a', 'New') ON CONFLICT (id) DO UPDATE SET name = excluded.name",
		"postgresql": "INSERT INTO items (id, name) VALUES ('a', 'New') ON CONFLICT (id) DO UPDATE SET name = excluded.name",
		"mysql":      "INSERT INTO items (id, name) VALUES ('a', 'New') ON DUPLICATE KEY UPDATE name = VALUES(name)",
	}
	eachEngine(t, func(t *testing.T, e engine, pool *sql.DB) {
		upsert, ok := upserts[e.name]
		if !ok {
			t.Skip("SQL Server has no single-statement upsert besides MERGE")
		}
		db := newItems(t, e, pool)
		exec(t, pool, "INSERT INTO items (id, name) VALUES ('a', 'Old')")
		handler := app(t, db, func(w http.ResponseWriter, r *http.Request) {
			if _, err := db.ExecContext(r.Context(), upsert); err != nil {
				t.Error(err)
			}
		})
		_, envelope := preview(t, handler, "/run")
		expectChanges(t, envelope["changes"], `update items {"id":"a"} Old>New`)
	})
}

// TestTriggeredWrites checks that SQLite and PostgreSQL capture rows written by
// triggers, and that keyed capture marks them as not shown.
func TestTriggeredWrites(t *testing.T) {
	triggers := map[string][]string{
		"sqlite": {`CREATE TRIGGER items_audit AFTER INSERT ON items BEGIN INSERT INTO audit (item, note) VALUES (NEW.id, 'created'); END`},
		"postgresql": {
			`CREATE FUNCTION items_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO audit (item, note) VALUES (NEW.id, 'created'); RETURN NEW; END $$`,
			`CREATE TRIGGER items_audit AFTER INSERT ON items FOR EACH ROW EXECUTE FUNCTION items_audit()`,
		},
		"mysql":     {`CREATE TRIGGER items_audit AFTER INSERT ON items FOR EACH ROW INSERT INTO audit (item, note) VALUES (NEW.id, 'created')`},
		"sqlserver": {`CREATE TRIGGER items_audit ON items AFTER INSERT AS INSERT INTO audit (item, note) SELECT id, 'created' FROM inserted`},
	}
	eachEngine(t, func(t *testing.T, e engine, pool *sql.DB) {
		db := newItems(t, e, pool)
		exec(t, pool, fmt.Sprintf("CREATE TABLE audit (item %s PRIMARY KEY, note %s)", e.text, e.text))
		exec(t, pool, triggers[e.name]...)
		handler := app(t, db, func(w http.ResponseWriter, r *http.Request) {
			if _, err := db.ExecContext(r.Context(), "INSERT INTO items (id, name) VALUES ('a', 'Item')"); err != nil {
				t.Error(err)
			}
		})
		_, envelope := preview(t, handler, "/run")
		lines := summary(envelope["changes"])
		switch e.name {
		case "sqlite", "postgresql":
			if len(lines) != 2 || !strings.HasPrefix(lines[0], "insert items") || !strings.HasPrefix(lines[1], "insert audit") || envelope["changesTruncated"] == true {
				t.Errorf("the triggered insert must follow the item, exactly: %v", lines)
			}
		default:
			if len(lines) != 1 || envelope["changesTruncated"] != true || !strings.Contains(logs(envelope), "triggers or foreign-key actions on items") {
				t.Errorf("keyed capture must mark triggered writes as not shown: %v %v", lines, logs(envelope))
			}
		}
		if count(t, pool, "audit") != 0 || count(t, pool, "items") != 0 {
			t.Error("the preview leaked")
		}
	})
}

func TestTablesWithoutPrimaryKey(t *testing.T) {
	eachEngine(t, func(t *testing.T, e engine, pool *sql.DB) {
		exec(t, pool, fmt.Sprintf("CREATE TABLE events (name %s NOT NULL)", e.text))
		db, err := dbsql.Wrap(pool)
		if err != nil {
			t.Fatal(err)
		}
		handler := app(t, db, func(w http.ResponseWriter, r *http.Request) {
			if _, err := db.ExecContext(r.Context(), "INSERT INTO events (name) VALUES ('created')"); err != nil {
				t.Error(err)
			}
		})
		_, envelope := preview(t, handler, "/run")
		lines := summary(envelope["changes"])
		switch e.name {
		case "sqlite":
			if len(lines) != 1 || lines[0] != `insert events {"rowid":1} ->created` {
				t.Errorf("SQLite identifies rows by rowid: %v", lines)
			}
		case "postgresql":
			if len(lines) != 1 || !strings.Contains(logs(envelope), "no primary key") {
				t.Errorf("PostgreSQL shows the row and says it has no key: %v %s", lines, logs(envelope))
			}
		default:
			if len(lines) != 0 || envelope["changesTruncated"] != true {
				t.Errorf("keyed capture cannot identify the row and must say so: %v", envelope)
			}
		}
		if count(t, pool, "events") != 0 {
			t.Error("the preview leaked")
		}
	})
}

func TestLargeTablesNeedNoSnapshot(t *testing.T) {
	eachEngine(t, func(t *testing.T, e engine, pool *sql.DB) {
		db := newItems(t, e, pool)
		values := make([]string, 0, 1000)
		for batch := 0; batch < 12; batch++ {
			values = values[:0]
			for row := 0; row < 1000; row++ {
				values = append(values, fmt.Sprintf("('row-%d-%d', 'x')", batch, row))
			}
			exec(t, pool, "INSERT INTO items (id, name) VALUES "+strings.Join(values, ", "))
		}
		handler := app(t, db, func(w http.ResponseWriter, r *http.Request) {
			_, _ = db.ExecContext(r.Context(), "UPDATE items SET name = 'y' WHERE id = 'row-3-7'")
		})
		status, envelope := preview(t, handler, "/run")
		if status != 200 {
			t.Fatalf("status %d: a large table must not make Preview unavailable", status)
		}
		expectChanges(t, envelope["changes"], `update items {"id":"row-3-7"} x>y`)
	})
}

func TestSecretParametersAreRedacted(t *testing.T) {
	eachEngine(t, func(t *testing.T, e engine, pool *sql.DB) {
		db := newItems(t, e, pool)
		secret := map[string]string{"sqlite": "SELECT @fixture_secret, @visible", "sqlserver": "SELECT @fixture_secret, @visible"}[e.name]
		if secret == "" {
			secret = "SELECT " + e.ph(1) + ", " + e.ph(2)
		}
		handler := app(t, db, func(w http.ResponseWriter, r *http.Request) {
			ctx := r.Context()
			rows, err := db.QueryContext(ctx, secret, sql.Named("fixture_secret", "s3cr3t-value"), sql.Named("visible", "shown"))
			if err != nil {
				t.Fatal(err)
			}
			rows.Close()
			rows, _ = db.QueryContext(ctx, "SELECT "+e.ph(1)+", "+e.ph(2), "positional-one", "positional-two")
			rows.Close()
			_, _ = db.ExecContext(ctx, "INSERT INTO items (id, name) VALUES ("+e.ph(1)+", "+e.ph(2)+")", "secret-adjacent", "n")
		})
		_, envelope := preview(t, handler, "/run")
		encoded, _ := json.Marshal(envelope)
		// A named placeholder names the secret in the text, which hides every value of
		// the statement; positional placeholders hide the secret-named argument.
		leaks := []string{"s3cr3t-value"}
		if strings.Contains(secret, "@fixture_secret") {
			leaks = append(leaks, "shown")
		}
		for _, leaked := range leaks {
			if strings.Contains(string(encoded), leaked) {
				t.Errorf("the statement naming a secret leaked %q", leaked)
			}
		}
		if !strings.Contains(string(encoded), "positional-one") {
			t.Error("a value without a secret-looking name was redacted")
		}
		if !strings.Contains(string(encoded), `"fixture_secret"`) || !strings.Contains(string(encoded), "[REDACTED]") {
			t.Errorf("expected the redacted secret parameter in %s", encoded)
		}
	})
}

func TestUnmarkedRoutesCannotCommitDuringPreview(t *testing.T) {
	eachEngine(t, func(t *testing.T, e engine, pool *sql.DB) {
		db := newItems(t, e, pool)
		bench, _ := sendproof.New(sendproof.WithEnvironment("Development"), sendproof.WithProvider(db.Provider()))
		_ = bench.Operation("POST", "/forgot") // advertised, but its handler below never calls Wrap
		var writeErr error
		mux := http.NewServeMux()
		write := func(w http.ResponseWriter, r *http.Request) {
			_, writeErr = db.ExecContext(r.Context(), "INSERT INTO items (id, name) VALUES ('sneaky', 'x')")
			w.WriteHeader(http.StatusNoContent)
		}
		mux.HandleFunc("POST /forgot", write)
		mux.HandleFunc("POST /unmarked", write)
		handler := bench.Middleware(mux)
		if status, _ := preview(t, handler, "/unmarked"); status != 409 || writeErr != nil {
			t.Errorf("an unregistered route ran: status %d, err %v", status, writeErr)
		}
		if status, envelope := preview(t, handler, "/forgot"); status == 200 || envelope["rolledBack"] == true {
			t.Errorf("a handler that never began a session was confirmed: %d %v", status, envelope)
		}
		if !errors.Is(writeErr, sendproof.ErrNoPreviewSession) {
			t.Errorf("the wrapper must fail closed, got %v", writeErr)
		}
		if count(t, pool, "items") != 0 {
			t.Error("an unmarked handler committed")
		}
	})
}

func TestCaptureLimitIsReported(t *testing.T) {
	eachEngine(t, func(t *testing.T, e engine, pool *sql.DB) {
		db := newItems(t, e, pool)
		insert := "INSERT INTO items (id, name) VALUES (" + e.ph(1) + ", " + e.ph(2) + ")"
		handler := app(t, db, func(w http.ResponseWriter, r *http.Request) {
			for index := 0; index < sendproof.MaxChanges+5; index++ {
				if _, err := db.ExecContext(r.Context(), insert, fmt.Sprintf("row-%03d", index), "x"); err != nil {
					t.Fatal(err)
				}
			}
		})
		_, envelope := preview(t, handler, "/run")
		lines := summary(envelope["changes"])
		if len(lines) != sendproof.MaxChanges || envelope["changesTruncated"] != true || lines[0] != `insert items {"id":"row-000"} ->x` {
			t.Errorf("got %d changes, truncated %v, first %v", len(lines), envelope["changesTruncated"], lines[:min(1, len(lines))])
		}
	})
}

func TestDialectDetection(t *testing.T) {
	eachEngine(t, func(t *testing.T, e engine, pool *sql.DB) {
		db, err := dbsql.Wrap(pool)
		if err != nil {
			t.Fatal(err)
		}
		want := map[string]dbsql.Dialect{"sqlite": dbsql.DialectSQLite, "postgresql": dbsql.DialectPostgres, "mysql": dbsql.DialectMySQL, "sqlserver": dbsql.DialectSQLServer}[e.name]
		if db.Dialect() != want {
			t.Errorf("detected %v, want %v", db.Dialect(), want)
		}
	})
}

// TestObservedGeneratedKeys covers keyed capture's generated-key paths in a real
// send: RETURNING on PostgreSQL, OUTPUT INSERTED on SQL Server and
// LAST_INSERT_ID on MySQL. SQLite reads the key from the hook.
func TestObservedGeneratedKeys(t *testing.T) {
	eachEngine(t, func(t *testing.T, e engine, pool *sql.DB) {
		exec(t, pool, fmt.Sprintf("CREATE TABLE notes (%s, name %s NOT NULL)", e.autoKey, e.text))
		db, err := dbsql.Wrap(pool)
		if err != nil {
			t.Fatal(err)
		}
		handler := app(t, db, func(w http.ResponseWriter, r *http.Request) {
			if _, err := db.ExecContext(r.Context(), "INSERT INTO notes (name) VALUES ('first'), ('second')"); err != nil {
				t.Error(err)
			}
			w.WriteHeader(http.StatusCreated)
		})
		status, trace := observe(t, handler, "/run")
		if status != 201 || trace["changesTruncated"] == true {
			t.Fatalf("status %d trace %v", status, trace)
		}
		expectChanges(t, trace["changes"], `insert notes {"id":1} ->first`, `insert notes {"id":2} ->second`)
		if count(t, pool, "notes") != 2 {
			t.Error("the observed send must commit")
		}
	})
}

// TestSQLiteEarlyRollbackStopsThePreview checks the rollback-hook safety net: a
// statement that rolls back the whole preview transaction stops the preview,
// so later statements cannot autocommit, and the preview is not confirmed.
func TestSQLiteEarlyRollbackStopsThePreview(t *testing.T) {
	e := allEngines[0]
	pool := openEngine(t, e)
	db := newItems(t, e, pool)
	var later error
	handler := app(t, db, func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		_, _ = db.ExecContext(ctx, "INSERT INTO items (id, name) VALUES ('a', 'First')")
		if _, err := db.ExecContext(ctx, "INSERT OR ROLLBACK INTO items (id, name) VALUES ('a', 'Conflict')"); err == nil {
			t.Error("the conflicting insert must fail")
		}
		_, later = db.ExecContext(ctx, "INSERT INTO items (id, name) VALUES ('b', 'Would autocommit')")
		w.WriteHeader(http.StatusOK)
	})
	status, envelope := preview(t, handler, "/run")
	if status == 200 || envelope["rolledBack"] == true {
		t.Errorf("a preview whose transaction ended early was confirmed: %d %v", status, envelope)
	}
	if later == nil {
		t.Error("a statement after the early rollback must be refused")
	}
	if count(t, pool, "items") != 0 {
		t.Error("a statement after the early rollback committed")
	}
}

// TestMySQLAutoIncrementStep checks that multi-row generated keys follow the
// session's auto_increment_increment, in a preview and an observed send.
func TestMySQLAutoIncrementStep(t *testing.T) {
	e := allEngines[2]
	pool := openEngine(t, e)
	exec(t, pool, fmt.Sprintf("CREATE TABLE notes (%s, name %s NOT NULL)", e.autoKey, e.text))
	db, err := dbsql.Wrap(pool)
	if err != nil {
		t.Fatal(err)
	}
	handler := app(t, db, func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		// The step is session state, so it is set on the request's own connection.
		if _, err := db.ExecContext(ctx, "SET SESSION auto_increment_increment = 5"); err != nil {
			t.Fatal(err)
		}
		if _, err := db.ExecContext(ctx, "INSERT INTO notes (name) VALUES ('first'), ('second'), ('third')"); err != nil {
			t.Error(err)
		}
		if _, err := db.ExecContext(ctx, "SET SESSION auto_increment_increment = 1"); err != nil {
			t.Error(err)
		}
		w.WriteHeader(http.StatusCreated)
	})
	_, envelope := preview(t, handler, "/run")
	expectChanges(t, envelope["changes"], `insert notes {"id":1} ->first`, `insert notes {"id":6} ->second`, `insert notes {"id":11} ->third`)
	if envelope["changesTruncated"] == true || count(t, pool, "notes") != 0 {
		t.Errorf("preview %v rows %d", envelope, count(t, pool, "notes"))
	}
	_, trace := observe(t, handler, "/run")
	lines := summary(trace["changes"])
	var ids []int
	for _, line := range lines {
		var id int
		fmt.Sscanf(line[strings.Index(line, ":")+1:], "%d", &id)
		ids = append(ids, id)
	}
	if len(ids) != 3 || ids[1]-ids[0] != 5 || ids[2]-ids[1] != 5 || trace["changesTruncated"] == true {
		t.Errorf("observed keys must step by 5: %v", lines)
	}
	var stored []int
	rows, _ := pool.Query("SELECT id FROM notes ORDER BY id")
	for rows.Next() {
		var id int
		_ = rows.Scan(&id)
		stored = append(stored, id)
	}
	rows.Close()
	if fmt.Sprint(stored) != fmt.Sprint(ids) {
		t.Errorf("captured keys %v, stored %v", ids, stored)
	}
}

// TestOneStatementOverTheLimit checks that a single statement changing more rows
// than the workbench keeps is bounded and reported as truncated.
func TestOneStatementOverTheLimit(t *testing.T) {
	eachEngine(t, func(t *testing.T, e engine, pool *sql.DB) {
		db := newItems(t, e, pool)
		values := make([]string, 0, 250)
		for index := 0; index < 250; index++ {
			values = append(values, fmt.Sprintf("('row-%03d', 'x')", index))
		}
		handler := app(t, db, func(w http.ResponseWriter, r *http.Request) {
			if _, err := db.ExecContext(r.Context(), "INSERT INTO items (id, name) VALUES "+strings.Join(values, ", ")); err != nil {
				t.Error(err)
			}
			if _, err := db.ExecContext(r.Context(), "UPDATE items SET name = 'y'"); err != nil {
				t.Error(err)
			}
		})
		status, envelope := preview(t, handler, "/run")
		lines := summary(envelope["changes"])
		if status != 200 || len(lines) != sendproof.MaxChanges || envelope["changesTruncated"] != true || lines[0] != `insert items {"id":"row-000"} ->x` {
			t.Errorf("status %d, %d changes, truncated %v", status, len(lines), envelope["changesTruncated"])
		}
		if count(t, pool, "items") != 0 {
			t.Error("the preview leaked")
		}
	})
}
