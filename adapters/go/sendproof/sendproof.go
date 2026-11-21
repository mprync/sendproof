// Package sendproof mounts the Sendproof workbench inside a Go HTTP application.
//
// A developer signs in to the API, picks an operation from its OpenAPI document and
// edits a typed request. Preview runs an eligible operation inside a transaction,
// returns its response, the row changes and the recorded side effects, and then
// rolls everything back. Send runs the ordinary request.
//
// Wire the bench around the application's http.Handler, mark the routes whose
// writes are safe to roll back, and give handlers a data-access wrapper that
// enlists in the preview transaction:
//
//	bench, err := sendproof.New(
//		sendproof.WithEnvironment("Development"),
//		sendproof.WithProvider(db.Provider()), // db is a *dbsql.DB
//		sendproof.WithPrincipal(principalFromSession),
//	)
//	if err != nil { /* handle */ }
//	mux.Handle("POST /items", bench.Operation("POST", "/items").Wrap(createItem))
//	server := &http.Server{Handler: bench.Middleware(mux)}
//
// A preview is only as complete as the data layer's enlistment. Raw handles that
// bypass the wrapper, other databases, caches, files and calls to other services
// are not rolled back. Mark a route only when its whole request path meets the
// boundary documented by the provider.
package sendproof

import (
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"
)

// Sendproof is the Sendproof runtime for one application. It is safe for concurrent
// use. Create it with New.
type Sendproof struct {
	cfg    config
	traces *traceStore

	mu  sync.RWMutex
	ops []*Operation
}

// New creates a Sendproof from options. It returns the first invalid option's error.
func New(options ...Option) (*Sendproof, error) {
	cfg := defaultConfig()
	for _, option := range options {
		if err := option(&cfg); err != nil {
			return nil, err
		}
	}
	return &Sendproof{cfg: cfg, traces: newTraceStore(cfg.traceTTL, cfg.clock)}, nil
}

// Enabled reports whether the workbench and Preview are available in the
// configured environment.
func (b *Sendproof) Enabled() bool {
	return slices.ContainsFunc(b.cfg.environments, func(name string) bool {
		return strings.EqualFold(name, b.cfg.environment)
	})
}

// provider returns the only registered provider, or nil when there is none or the
// choice is ambiguous.
func (b *Sendproof) provider() Provider {
	if len(b.cfg.providers) != 1 {
		return nil
	}
	return b.cfg.providers[0]
}

func (b *Sendproof) includeSQLValues() bool {
	if b.cfg.sqlValues != nil {
		return *b.cfg.sqlValues
	}
	return strings.EqualFold(b.cfg.environment, "Development")
}

func (b *Sendproof) pathBase(r *http.Request) string {
	if base := PathBase(r); base != "" {
		return base
	}
	return b.cfg.pathBase
}

// principal resolves the host's identity for a request.
func (b *Sendproof) principal(r *http.Request) (Principal, bool) {
	if b.cfg.principal == nil {
		return Principal{}, false
	}
	return b.cfg.principal(r)
}

// owner derives the trace owner from the request's principal. A principal without
// a stable subject owns nothing.
func (b *Sendproof) owner(r *http.Request) (traceOwner, bool) {
	principal, ok := b.principal(r)
	base := b.pathBase(r)
	if !ok || principal.Subject == "" || len(principal.Subject) > maxName || len(principal.Scheme) > maxName ||
		len(principal.Issuer) > maxText || len(base) > 4096 {
		return traceOwner{}, false
	}
	return traceOwner{scheme: principal.Scheme, issuer: principal.Issuer, subject: principal.Subject, pathBase: base}, true
}

// authorize applies the workbench access policy. It returns the HTTP status to
// answer with, or 0 when the request is allowed.
func (b *Sendproof) authorize(r *http.Request) int {
	if b.cfg.access == nil || b.cfg.access(r) {
		return 0
	}
	if _, authenticated := b.principal(r); !authenticated && b.cfg.principal != nil {
		return http.StatusUnauthorized
	}
	return http.StatusForbidden
}

// Operation marks one route as eligible for Preview and observed Send. Create it
// once per route when the route is registered.
type Operation struct {
	bench    *Sendproof
	method   string
	path     string // OpenAPI path template
	segments []string
	rest     bool
}

// Operation registers a route as eligible for Preview and returns its marker. The
// path is the full application path with the router's prefix, written as an
// OpenAPI template such as /items/{id}. A trailing wildcard is written {name...}.
// Registered operations are advertised to the workbench only when a provider is
// registered.
func (b *Sendproof) Operation(method, path string) *Operation {
	template, rest := normalizeTemplate(path)
	op := &Operation{bench: b, method: strings.ToUpper(method), path: template, rest: rest}
	op.segments = strings.Split(strings.Trim(template, "/"), "/")
	b.mu.Lock()
	b.ops = append(b.ops, op)
	b.mu.Unlock()
	return op
}

// Router is the subset of http.ServeMux used by HandlePreview.
type Router interface {
	Handle(pattern string, handler http.Handler)
}

// HandlePreview registers handler on the router under a "METHOD /path" pattern
// and marks it for Preview. It is a shortcut for mux.Handle(pattern,
// bench.Operation(method, path).Wrap(handler)) with http.ServeMux's pattern syntax.
func (b *Sendproof) HandlePreview(router Router, pattern string, handler http.Handler) {
	method, path, found := strings.Cut(pattern, " ")
	if !found || !strings.HasPrefix(strings.TrimSpace(path), "/") {
		panic("sendproof: HandlePreview needs a \"METHOD /path\" pattern, got " + pattern)
	}
	router.Handle(pattern, b.Operation(method, strings.TrimSpace(path)).Wrap(handler))
}

// normalizeTemplate converts a ServeMux-style pattern into an OpenAPI path
// template, reporting whether it ends in a wildcard.
func normalizeTemplate(path string) (string, bool) {
	rest := false
	segments := strings.Split(path, "/")
	for index, segment := range segments {
		switch {
		case segment == "{$}":
			segments[index] = ""
		case strings.HasPrefix(segment, "{") && strings.HasSuffix(segment, "...}"):
			segments[index] = strings.TrimSuffix(segment, "...}") + "}"
			rest = true
		}
	}
	template := strings.Join(segments, "/")
	if template == "" {
		template = "/"
	}
	return template, rest
}

// matches reports whether a concrete request path belongs to the operation.
func (o *Operation) matches(method, escapedPath string) bool {
	if o.method != method {
		return false
	}
	parts := strings.Split(strings.Trim(escapedPath, "/"), "/")
	if o.rest {
		if len(parts) < len(o.segments) {
			return false
		}
	} else if len(parts) != len(o.segments) {
		return false
	}
	for index, want := range o.segments {
		if strings.Contains(want, "{") {
			if parts[index] == "" {
				return false
			}
			continue
		}
		if unescaped, err := unescape(parts[index]); err != nil || unescaped != want {
			return false
		}
	}
	return true
}

// previewOperations lists the advertised operations in a stable order.
func (b *Sendproof) previewOperations() []map[string]string {
	if b.provider() == nil {
		return []map[string]string{}
	}
	b.mu.RLock()
	defer b.mu.RUnlock()
	seen := map[string]bool{}
	var operations []map[string]string
	for _, op := range b.ops {
		key := op.method + " " + op.path
		if op.method == http.MethodHead || seen[key] {
			continue
		}
		seen[key] = true
		operations = append(operations, map[string]string{"method": op.method, "path": op.path})
	}
	slices.SortFunc(operations, func(a, c map[string]string) int {
		if byPath := strings.Compare(a["path"], c["path"]); byPath != 0 {
			return byPath
		}
		return strings.Compare(a["method"], c["method"])
	})
	if operations == nil {
		operations = []map[string]string{}
	}
	return operations
}

// hasOperation reports whether a request targets a registered operation.
func (b *Sendproof) hasOperation(method, escapedPath string) bool {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return slices.ContainsFunc(b.ops, func(op *Operation) bool { return op.matches(method, escapedPath) })
}

// Wrap marks handler as the operation's implementation. During a preview it
// begins the provider's transaction before the handler runs. During an observed
// send it starts trace capture. Otherwise it calls handler unchanged.
func (o *Operation) Wrap(handler http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if o.Enter(w, r) {
			handler.ServeHTTP(w, r)
			o.Complete(r)
		}
	})
}

// Middleware returns the operation's marker as standard net/http middleware, for
// routers such as chi.
func (o *Operation) Middleware() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler { return o.Wrap(next) }
}

// Enter is the marker for routers that do not use http.Handler middleware. Call it
// before the handler runs. When it returns false the response is already decided
// and the handler must not run.
func (o *Operation) Enter(w http.ResponseWriter, r *http.Request) bool {
	state := stateFrom(r.Context())
	if state == nil || state.kind == kindNone {
		return true
	}
	if state.kind == kindPreview {
		return state.enterPreview(w, r, o)
	}
	state.enterObserved(r, o)
	return true
}

// Complete records that the marked handler returned normally. Preview confirms a
// result only for a handler that completed, so a panic that a recovery middleware
// turned into an error response is never confirmed. Call it after the handler, in
// routers that use Enter directly.
func (o *Operation) Complete(r *http.Request) {
	if state := stateFrom(r.Context()); state != nil {
		state.mu.Lock()
		state.completed = state.invoked
		state.mu.Unlock()
	}
}

// now returns the current time for traces.
func (b *Sendproof) now() time.Time { return b.cfg.clock() }
