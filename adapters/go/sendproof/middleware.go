package sendproof

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func unescape(value string) (string, error) { return url.PathUnescape(value) }

// Middleware wraps the application handler. It serves the workbench under
// /sendproof/, answers the reserved /sendproof/_preview route, and prepares observed sends.
// Place it outside the application's router and authentication middleware, so a
// preview is routed, authenticated and authorized exactly like the real request.
// When the workbench is disabled for the environment, only the preview route is
// answered (with HTTP 404) and everything else reaches next untouched.
func (b *Sendproof) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		r = withPathBase(r, b.cfg.pathBase)
		// Store writes made with this request's context are attributed to it, so
		// they never fail another request's open Preview (see ReportWrite).
		r = r.WithContext(context.WithValue(r.Context(), requestKey{}, true))
		escaped := r.URL.EscapedPath()

		if hasSegmentPrefix(escaped, previewPrefix) {
			b.servePreview(w, r, next, escaped[len(previewPrefix):], started)
			return
		}
		enabled := b.Enabled()
		if enabled && hasSegmentPrefix(r.URL.Path, workbenchPrefix) {
			b.serveWorkbench(w, r)
			return
		}
		if requestsRollback(r) {
			reject(w, http.StatusBadRequest, "Use the Sendproof preview URL for rollback requests.")
			return
		}
		if enabled && r.Method != http.MethodHead && requestsTrace(r) && isSameOrigin(r) {
			state := &requestState{bench: b, kind: kindObserved, rec: newRecorder(b, started), pathBase: b.pathBase(r)}
			observed := &observedWriter{ResponseWriter: w, state: state}
			defer b.finishObserved(r, state)
			next.ServeHTTP(observed, withState(r, state))
			return
		}
		next.ServeHTTP(w, r)
	})
}

// serveWorkbench answers the /sendproof routes: the UI, discovery and traces.
func (b *Sendproof) serveWorkbench(w http.ResponseWriter, r *http.Request) {
	if status := b.authorize(r); status != 0 {
		title := "Authentication is required for the workbench."
		if status == http.StatusForbidden {
			title = "The workbench is forbidden."
		}
		reject(w, status, title)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		reject(w, http.StatusMethodNotAllowed, "The workbench accepts only GET requests.")
		return
	}
	switch path := r.URL.Path; {
	case path == workbenchPrefix:
		target := b.pathBase(r) + "/sendproof/"
		if r.URL.RawQuery != "" {
			target += "?" + r.URL.RawQuery
		}
		http.Redirect(w, r, target, http.StatusFound)
	case path == "/sendproof/" || path == "/sendproof/signin.html":
		serveAsset(w, r, "index.html")
	case path == "/sendproof/_api/capabilities":
		b.serveCapabilities(w, r)
	case strings.HasPrefix(path, "/sendproof/_api/traces/"):
		b.serveTrace(w, r, strings.TrimPrefix(path, "/sendproof/_api/traces/"))
	case strings.HasPrefix(path, "/sendproof/_api/"):
		http.NotFound(w, r)
	default:
		serveAsset(w, r, strings.TrimPrefix(path, "/sendproof/"))
	}
}

// serveCapabilities answers GET /sendproof/_api/capabilities.
func (b *Sendproof) serveCapabilities(w http.ResponseWriter, r *http.Request) {
	base := b.pathBase(r)
	openAPIURL := base + b.cfg.openAPIURL
	documents := make([]map[string]string, 0, len(b.cfg.documents)+1)
	hasPrimary := false
	for _, doc := range b.cfg.documents {
		documents = append(documents, map[string]string{"name": doc.Name, "url": base + doc.URL})
		hasPrimary = hasPrimary || base+doc.URL == openAPIURL
	}
	if !hasPrimary {
		documents = append([]map[string]string{{"name": b.cfg.apiName, "url": openAPIURL}}, documents...)
	}
	providers := make([]map[string]any, 0, len(b.cfg.authProviders))
	for _, provider := range b.cfg.authProviders {
		providers = append(providers, map[string]any{"label": provider.Label, "kind": provider.Kind, "url": base + provider.URL})
	}
	modules := make([]string, 0, len(b.cfg.fieldModules))
	for _, module := range b.cfg.fieldModules {
		modules = append(modules, base+module)
	}

	var identity any
	if principal, ok := b.principal(r); ok {
		entry := map[string]any{"name": principal.Name}
		if principal.Role != "" {
			entry["role"] = principal.Role
		}
		identity = entry
	}
	// Discovery is public in Development, so a label that looks like connection
	// details is withheld rather than published.
	database := b.databaseDescription()
	operations := b.previewOperations()
	capabilities := map[string]any{
		"protocolVersion":   1,
		"apiName":           b.cfg.apiName,
		"openApiUrl":        openAPIURL,
		"fieldModules":      modules,
		"environment":       b.cfg.environment,
		"database":          database,
		"binding":           map[string]string{"language": "go", "framework": b.cfg.framework},
		"identity":          identity,
		"authProviders":     providers,
		"previewOperations": operations,
		"observedSend":      len(operations) > 0,
		"documents":         documents,
	}
	if b.previewReady() {
		if unavailable := b.previewUnavailable(); len(unavailable) > 0 {
			capabilities["previewUnavailable"] = unavailable
		}
	}
	if len(b.cfg.stores) > 0 {
		capabilities["dataStores"] = b.dataStores(r.Context())
	}
	writeJSON(w, http.StatusOK, capabilities)
}

// DatabaseSystem is an optional Provider extension that names the SQL engine, so
// discovery can say `database.system` and the workbench shows the right mark. The
// id is the provider id of the workbench's store marks: "sqlite", "postgresql",
// "mysql", "mariadb" or "sqlserver".
type DatabaseSystem interface {
	// System returns the SQL provider id.
	System() string
}

// databaseDescription builds capabilities `database`: the display name, or
// `{name, system}` when the provider says which engine it is. It is nil without a
// SQL provider.
func (b *Sendproof) databaseDescription() any {
	provider := b.provider()
	if provider == nil {
		return nil
	}
	var name any
	if label := provider.Database(); label != "" && IsDisplayLabel(label) {
		name = label
	}
	if system, ok := provider.(DatabaseSystem); ok && system.System() != "" {
		return map[string]any{"name": name, "system": system.System()}
	}
	return name
}

// serveTrace answers GET /sendproof/_api/traces/{id}. Missing, expired and foreign
// traces are indistinguishable: all return 404.
func (b *Sendproof) serveTrace(w http.ResponseWriter, r *http.Request, id string) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	owner, ok := b.owner(r)
	if !ok || !isSameOrigin(r) || !validTraceID(id) {
		http.NotFound(w, r)
		return
	}
	result := b.traces.read(r.Context(), id, owner)
	if result == nil {
		http.NotFound(w, r)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// validTraceID accepts the 32-digit hex form, with or without GUID hyphens.
func validTraceID(id string) bool {
	id = strings.ReplaceAll(id, "-", "")
	if len(id) != 32 {
		return false
	}
	for _, c := range id {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return true
}
