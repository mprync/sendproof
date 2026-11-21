package testbench

import (
	"net/http"
	"net/url"
	"strings"
	"time"
)

func unescape(value string) (string, error) { return url.PathUnescape(value) }

// Middleware wraps the application handler. It serves the workbench under
// /bench/, answers the reserved /bench/_preview route, and prepares observed sends.
// Place it outside the application's router and authentication middleware, so a
// preview is routed, authenticated and authorized exactly like the real request.
// When the workbench is disabled for the environment, only the preview route is
// answered (with HTTP 404) and everything else reaches next untouched.
func (b *Bench) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		r = withPathBase(r, b.cfg.pathBase)
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
			reject(w, http.StatusBadRequest, "Use the Test Bench preview URL for rollback requests.")
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

// serveWorkbench answers the /bench routes: the UI, discovery and traces.
func (b *Bench) serveWorkbench(w http.ResponseWriter, r *http.Request) {
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
		target := b.pathBase(r) + "/bench/"
		if r.URL.RawQuery != "" {
			target += "?" + r.URL.RawQuery
		}
		http.Redirect(w, r, target, http.StatusFound)
	case path == "/bench/" || path == "/bench/signin.html":
		serveAsset(w, r, "index.html")
	case path == "/bench/_api/capabilities":
		b.serveCapabilities(w, r)
	case strings.HasPrefix(path, "/bench/_api/traces/"):
		b.serveTrace(w, r, strings.TrimPrefix(path, "/bench/_api/traces/"))
	case strings.HasPrefix(path, "/bench/_api/"):
		http.NotFound(w, r)
	default:
		serveAsset(w, r, strings.TrimPrefix(path, "/bench/"))
	}
}

// serveCapabilities answers GET /bench/_api/capabilities.
func (b *Bench) serveCapabilities(w http.ResponseWriter, r *http.Request) {
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
	var database any
	if provider := b.provider(); provider != nil && provider.Database() != "" && IsDisplayLabel(provider.Database()) {
		database = provider.Database()
	}
	operations := b.previewOperations()
	writeJSON(w, http.StatusOK, map[string]any{
		"protocolVersion":   1,
		"apiName":           b.cfg.apiName,
		"openApiUrl":        openAPIURL,
		"fieldModules":      modules,
		"environment":       b.cfg.environment,
		"database":          database,
		"identity":          identity,
		"authProviders":     providers,
		"previewOperations": operations,
		"observedSend":      len(operations) > 0,
		"documents":         documents,
	})
}

// serveTrace answers GET /bench/_api/traces/{id}. Missing, expired and foreign
// traces are indistinguishable: all return 404.
func (b *Bench) serveTrace(w http.ResponseWriter, r *http.Request, id string) {
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
