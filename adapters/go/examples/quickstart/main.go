// Command quickstart is a minimal API with Test Bench mounted at /bench.
//
// It uses net/http and database/sql with an in-process SQLite database. Run it
// from adapters/go/examples and open http://localhost:8080/bench/:
//
//	go run ./quickstart
//
// Sign in is intentionally trivial: the example trusts a "dev" cookie so the
// workbench has an identity. Real applications resolve the principal from their
// own session or token.
package main

import (
	"database/sql"
	"encoding/json"
	"log"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite" // pure-Go SQLite with the pre-update hook dbsql captures changes with

	"github.com/test-bench/test-bench/adapters/go/dbsql"
	"github.com/test-bench/test-bench/adapters/go/testbench"
)

func main() {
	directory, err := os.MkdirTemp("", "testbench-quickstart-")
	if err != nil {
		log.Fatal(err)
	}
	defer os.RemoveAll(directory)

	pool, err := sql.Open("sqlite", "file:"+filepath.Join(directory, "app.db")+"?_pragma=busy_timeout(5000)")
	if err != nil {
		log.Fatal(err)
	}
	if _, err := pool.Exec(`CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL)`); err != nil {
		log.Fatal(err)
	}

	// Run every query through the wrapper so a preview can enlist in its transaction.
	db, err := dbsql.Wrap(pool, dbsql.WithDatabaseLabel("quickstart.db"))
	if err != nil {
		log.Fatal(err)
	}

	bench, err := testbench.New(
		testbench.WithEnvironment("Development"),
		testbench.WithAPIName("Quickstart API"),
		testbench.WithOpenAPIURL("/openapi.json"),
		testbench.WithProvider(db.Provider()),
		testbench.WithPrincipal(func(r *http.Request) (testbench.Principal, bool) {
			if _, err := r.Cookie("dev"); err != nil {
				return testbench.Principal{}, false
			}
			return testbench.Principal{Subject: "dev", Name: "Developer", Role: "admin", Scheme: "cookie"}, true
		}),
	)
	if err != nil {
		log.Fatal(err)
	}

	// Log with the request context so records also appear in previews and traces.
	logger := slog.New(testbench.SlogHandler(slog.NewTextHandler(os.Stderr, nil)))

	mux := http.NewServeMux()
	mux.HandleFunc("GET /openapi.json", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(openAPI))
	})
	mux.HandleFunc("GET /dev", func(w http.ResponseWriter, r *http.Request) { // trivial sign-in
		http.SetCookie(w, &http.Cookie{Name: "dev", Value: "1", Path: "/"})
		http.Redirect(w, r, "/bench/", http.StatusFound)
	})

	// Marking a route makes it eligible for Preview. Only mark routes whose writes
	// all go through db and whose other side effects are recorded below.
	bench.HandlePreview(mux, "POST /items", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var item struct{ ID, Name string }
		if json.NewDecoder(r.Body).Decode(&item) != nil || item.ID == "" || item.Name == "" {
			http.Error(w, `{"error":"id and name are required"}`, http.StatusBadRequest)
			return
		}
		if _, err := db.ExecContext(r.Context(), "INSERT INTO items (id, name) VALUES (?, ?)", item.ID, item.Name); err != nil {
			http.Error(w, `{"error":"could not insert"}`, http.StatusConflict)
			return
		}
		// A preview records the email and suppresses it; Send delivers it.
		if !testbench.RecordEmail(r.Context(), "Stock notice", "bench@example.test", []string{"ops@example.test"}, "New item", item.Name) {
			logger.InfoContext(r.Context(), "sending the stock notice", "item", item.ID)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]string{"id": item.ID, "name": item.Name})
	}))
	mux.HandleFunc("GET /items/{id}", func(w http.ResponseWriter, r *http.Request) {
		var name string
		err := db.QueryRowContext(r.Context(), "SELECT name FROM items WHERE id = ?", r.PathValue("id")).Scan(&name)
		if err == sql.ErrNoRows {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"id": r.PathValue("id"), "name": name})
	})

	addr := ":8080"
	log.Printf("Quickstart API on http://localhost%s — open /dev once to sign in, then /bench/", addr)
	log.Fatal(http.ListenAndServe(addr, bench.Middleware(mux)))
}

const openAPI = `{
  "openapi": "3.1.0",
  "info": {"title": "Quickstart API", "version": "1.0.0"},
  "paths": {
    "/items": {"post": {"summary": "Create an item",
      "requestBody": {"required": true, "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Item"}}}},
      "responses": {"201": {"description": "Created"}}}},
    "/items/{id}": {"get": {"summary": "Read an item",
      "parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "string"}}],
      "responses": {"200": {"description": "The item"}, "404": {"description": "Not found"}}}}
  },
  "components": {"schemas": {"Item": {"type": "object", "required": ["id", "name"],
    "properties": {"id": {"type": "string"}, "name": {"type": "string"}}}}}
}`
