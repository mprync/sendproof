// Package fixture is the Go implementation of the Test Bench conformance
// fixture (spec/conformance/fixture.md). One handler set is bound to net/http,
// chi, Gin and Echo, and to database/sql or GORM, so every adapter is exercised
// through the same protocol checks.
package fixture

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/test-bench/test-bench/adapters/go/testbench"
)

// Config selects the fixture's behavior.
type Config struct {
	// Framework is "nethttp", "chi", "gin" or "echo".
	Framework string
	// Store is "sql" (database/sql, the default) or "gorm".
	Store string
	// Scenario is "standard", "disabled", "no-provider" or "rollback-failure".
	Scenario string
	// PathBase is the mount prefix, empty or such as "/tenant".
	PathBase string
	// TraceTTL is how long observed traces stay readable. The default is five seconds.
	TraceTTL time.Duration
	// Database selects the engine. The default is a fresh SQLite file.
	Database Database
}

// New builds the fixture handler on its database and creates the items table.
// Server engines must point at a fresh, empty database. Call the returned
// function to release the database.
func New(cfg Config) (http.Handler, func(), error) {
	database := cfg.Database
	var directory string
	if database.Directory == "" {
		var err error
		if directory, err = os.MkdirTemp("", "testbench-fixture-"); err != nil {
			return nil, nil, err
		}
		database.Directory = directory
	}
	removeDirectory := func() {
		if directory != "" {
			_ = os.RemoveAll(directory)
		}
	}
	data, err := openStore(cfg.Store, database)
	if err != nil {
		removeDirectory()
		return nil, nil, err
	}
	cleanup := func() {
		_ = data.close()
		removeDirectory()
	}

	people := newSessions()
	options := []testbench.Option{
		testbench.WithEnvironment("Development"),
		testbench.WithAPIName("Test Bench Conformance"),
		testbench.WithOpenAPIURL("/openapi.json"),
		testbench.WithAuthProvider("Password", "cookie", "/auth/sign-in"),
		testbench.WithAuthProvider("Development personas", "personas", "/auth/personas"),
		testbench.WithPrincipal(people.principal),
		testbench.WithTraceTTL(orDefault(cfg.TraceTTL, 5*time.Second)),
		testbench.WithLogger(slog.New(slog.NewTextHandler(io.Discard, nil))),
	}
	switch cfg.Scenario {
	case "disabled":
		// Outside the configured environments the workbench and Preview are off.
		options = append(options, testbench.WithEnvironment("Production"))
	case "no-provider":
	case "rollback-failure":
		options = append(options, testbench.WithProvider(failingRollback{data.provider()}))
	case "", "standard":
		options = append(options, testbench.WithProvider(data.provider()))
	default:
		cleanup()
		return nil, nil, fmt.Errorf("unknown scenario %q", cfg.Scenario)
	}
	bench, err := testbench.New(options...)
	if err != nil {
		cleanup()
		return nil, nil, err
	}

	logger := slog.New(testbench.SlogHandler(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelWarn})))
	app := &handlers{store: data, logger: logger}

	shared := http.NewServeMux()
	shared.HandleFunc("GET /ready", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	shared.HandleFunc("GET /openapi.json", serveOpenAPI)
	people.registerAuth(shared)

	var router http.Handler
	switch cfg.Framework {
	case "", "nethttp":
		router = bindNetHTTP(bench, people, app, shared)
	case "chi":
		router = bindChi(bench, people, app, shared)
	case "gin":
		router = bindGin(bench, people, app, shared)
	case "echo":
		router = bindEcho(bench, people, app, shared)
	default:
		cleanup()
		return nil, nil, fmt.Errorf("unknown framework %q", cfg.Framework)
	}
	return testbench.StripPathBase(cfg.PathBase, bench.Middleware(router)), cleanup, nil
}

func orDefault(value, fallback time.Duration) time.Duration {
	if value > 0 {
		return value
	}
	return fallback
}

// route is one item operation of the fixture.
type route struct {
	method, path string
	admin        bool
	preview      bool
	handler      func(*handlers) http.HandlerFunc
}

// routes lists the item operations. Marked routes are eligible for Preview.
var routes = []route{
	{"POST", "/items", true, true, func(h *handlers) http.HandlerFunc { return h.create }},
	{"GET", "/items/{id}", false, false, func(h *handlers) http.HandlerFunc { return h.read }},
	{"PATCH", "/items/{id}", true, true, func(h *handlers) http.HandlerFunc { return h.patch }},
	{"DELETE", "/items/{id}", true, true, func(h *handlers) http.HandlerFunc { return h.remove }},
	{"POST", "/items/{id}/fail", true, true, func(h *handlers) http.HandlerFunc { return h.failing }},
	{"POST", "/items/{id}/large", true, true, func(h *handlers) http.HandlerFunc { return h.large }},
	{"POST", "/items/{id}/redirect", true, true, func(h *handlers) http.HandlerFunc { return h.redirect }},
	{"POST", "/items/{id}/capture", true, true, func(h *handlers) http.HandlerFunc { return h.capture }},
	{"POST", "/items/{id}/ordinary", true, false, func(h *handlers) http.HandlerFunc { return h.ordinary }},
}

func (r route) role() string {
	if r.admin {
		return "admin"
	}
	return ""
}

// failingRollback wraps a provider so that its sessions report a rollback failure
// after really rolling back, which is how a broken transport must be detected.
type failingRollback struct{ testbench.Provider }

func (p failingRollback) Begin(ctx context.Context) (testbench.Session, error) {
	session, err := p.Provider.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return &failingSession{Session: session}, nil
}

type failingSession struct{ testbench.Session }

// Unwrap exposes the real session, so the data layer still enlists in it.
func (s *failingSession) Unwrap() testbench.Session { return s.Session }

func (s *failingSession) Rollback(ctx context.Context) error {
	_ = s.Session.Rollback(ctx) // discard the data, then report the injected failure
	return fmt.Errorf("injected rollback failure")
}
