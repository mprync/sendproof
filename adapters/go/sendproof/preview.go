package sendproof

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"time"
)

// previewEnvelope is the confirmed result of a preview, in the wire format of the
// preview schema.
type previewEnvelope struct {
	Status           int               `json:"status"`
	Headers          map[string]string `json:"headers"`
	Body             any               `json:"body"`
	Changes          []Change          `json:"changes"`
	Effects          []previewEffect   `json:"effects"`
	Logs             []previewLog      `json:"logs"`
	RolledBack       bool              `json:"rolledBack"`
	ChangesTruncated bool              `json:"changesTruncated,omitempty"`
	EffectsTruncated bool              `json:"effectsTruncated,omitempty"`
	LogsTruncated    bool              `json:"logsTruncated,omitempty"`
}

// servePreview handles /sendproof/_preview/{target}. It validates the transport,
// dispatches the rewritten request through the application's own handler, and
// confirms the result only after the provider has rolled back.
func (b *Sendproof) servePreview(w http.ResponseWriter, r *http.Request, next http.Handler, target string, started time.Time) {
	switch {
	case !b.Enabled():
		reject(w, http.StatusNotFound, "Sendproof previews are unavailable.")
		return
	case !hasExactRollbackPreference(r):
		reject(w, http.StatusBadRequest, "A Sendproof preview requires Prefer: tx=rollback.")
		return
	case r.Method == http.MethodHead:
		reject(w, http.StatusMethodNotAllowed, "A preview requires a response body.")
		return
	case !validTarget(target):
		reject(w, http.StatusBadRequest, "The Sendproof preview target is invalid.")
		return
	case !isSameOrigin(r):
		reject(w, http.StatusForbidden, "Cross-origin preview requests are not allowed.")
		return
	case r.URL.Query().Has("_method"):
		// A method-override middleware would route the preview to an operation
		// other than the one checked below.
		reject(w, http.StatusBadRequest, "A Sendproof preview cannot override its method.")
		return
	}
	if status := b.authorize(r); status != 0 {
		title := "Authentication is required for this preview."
		if status == http.StatusForbidden {
			title = "This preview is forbidden."
		}
		reject(w, status, title)
		return
	}
	if !b.previewReady() {
		reject(w, http.StatusServiceUnavailable, "Preview requires one available preview provider.")
		return
	}
	// Only routes that were marked for preview may run. Checking before dispatch
	// keeps an unreviewed handler, with its unrecorded effects, from executing.
	if !b.hasOperation(r.Method, target) {
		reject(w, http.StatusConflict, "This operation is unavailable for preview.")
		return
	}

	decoded, err := url.PathUnescape(target)
	if err != nil {
		reject(w, http.StatusBadRequest, "The Sendproof preview target is invalid.")
		return
	}
	state := &requestState{bench: b, kind: kindPreview, rec: newRecorder(b, started), pathBase: b.pathBase(r),
		target: decoded, method: r.Method, escaped: target}
	// While the handler and cleanup run, a store write with no request context may
	// be this handler's: it fails the Preview (see ReportWrite).
	openPreview(state)
	defer closePreview(state)
	inner := withState(r.Clone(r.Context()), state)
	inner.URL.Path, inner.URL.RawPath = decoded, ""
	if inner.URL.EscapedPath() != target {
		inner.URL.RawPath = target
	}
	inner.RequestURI = inner.URL.RequestURI()
	// An encoding middleware would compress the buffered body the preview must read.
	inner.Header.Del("Accept-Encoding")
	for _, name := range methodOverrideHeaders {
		inner.Header.Del(name)
	}

	capture := newCaptureWriter()
	capture.header.Set("Cache-Control", "no-store")
	failure := runProtected(func() { next.ServeHTTP(capture, inner) })
	state.rec.endHandler()

	// Cleanup uses a context that outlives a disconnected client, so rollback and
	// disposal always complete.
	cleanup := context.WithoutCancel(r.Context())
	var envelope *previewEnvelope
	state.mu.Lock()
	session, invoked, completed, beginFailure := state.session, state.invoked, state.completed, state.failure
	stores := append([]storeEntry(nil), state.stores...)
	state.mu.Unlock()
	handlerFailure := errors.Join(failure, beginFailure)
	var cleanupFailure error
	if invoked {
		// Pipeline order (spec/data-stores.md): abort every store transaction, then
		// roll back SQL. Both always run, so one failure never leaves the other open.
		// Stores report changes and faults through the Preview scope, so Finish gets
		// the context of this Preview, not the outer request's.
		finishing := context.WithValue(cleanup, stateKey{}, state)
		for _, entry := range stores {
			if entry.preview != nil {
				cleanupFailure = errors.Join(cleanupFailure, protect("a data store Finish", func() error { return entry.preview.Finish(finishing) }))
			}
		}
		if session != nil {
			cleanupFailure = errors.Join(cleanupFailure, protect("the provider rollback", func() error { return session.Rollback(cleanup) }))
		}
		blocked, fault := state.outcome()
		if cleanupFailure == nil && fault == nil && blocked == nil && handlerFailure == nil && completed && !capture.exceeded {
			envelope = b.buildEnvelope(capture, session, state, state.rec.finish())
		}
		if state.rec.isActive() {
			state.rec.finish()
		}
		for _, entry := range stores {
			if entry.preview != nil {
				cleanupFailure = errors.Join(cleanupFailure, protect("a data store Close", entry.preview.Close))
			}
		}
		if session != nil {
			cleanupFailure = errors.Join(cleanupFailure, protect("the provider session Close", session.Close))
		}
	}
	if r.Context().Err() != nil {
		return
	}
	blocked, fault := state.outcome()
	// A failed rollback, abort or disposal, or a refused transaction-control
	// command, always withholds confirmation, and outranks a blocked write.
	if fault != nil {
		cleanupFailure = errors.Join(cleanupFailure, fault)
	}
	if cleanupFailure == nil && blocked != nil && beginFailure == nil && (failure == nil || isBlockedFailure(failure)) {
		// The record decides, not the handler: a handler that caught the refusal and
		// returned 200, or panicked with it, still gets the 409.
		serveBlocked(w, *blocked)
		return
	}
	// A response that is too large is reported as such even if the handler then
	// failed on the write error.
	if cleanupFailure != nil || handlerFailure != nil && !capture.exceeded {
		b.cfg.logger.Error("a Sendproof preview failed", "method", r.Method, "path", r.URL.Path,
			"error", errors.Join(handlerFailure, cleanupFailure))
		reject(w, http.StatusInternalServerError, "The preview could not be completed safely.")
		return
	}
	if capture.exceeded {
		reject(w, http.StatusRequestEntityTooLarge, "The preview response exceeds the 1 MiB limit.")
		return
	}
	if envelope == nil {
		rejectUnexecuted(w, capture, invoked)
		return
	}

	serialized := time.Now()
	encoded, err := json.Marshal(envelope)
	if err != nil {
		b.cfg.logger.Error("a Sendproof preview could not be serialized", "error", err)
		reject(w, http.StatusInternalServerError, "The preview could not be completed safely.")
		return
	}
	timing := state.rec.timing(float64(time.Since(serialized)) / float64(time.Millisecond))
	headers := w.Header()
	headers.Set("Cache-Control", "no-store")
	headers.Set("Preference-Applied", rollbackPrefer)
	headers.Set(serverTimingName, timing.header())
	headers.Set("Content-Type", "application/json; charset=utf-8")
	_, _ = w.Write(encoded)
}

// methodOverrideHeaders are removed from the dispatched preview so a method
// override middleware cannot run an operation other than the checked one.
var methodOverrideHeaders = []string{"X-HTTP-Method-Override", "X-HTTP-Method", "X-Method-Override"}

// outcome returns the first blocked write and the first transaction-control
// fault the data-store guards recorded during the Preview.
func (s *requestState) outcome() (*blockedWrite, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.blocked, s.fault
}

// isBlockedFailure reports whether a handler failure is the guard's own refusal,
// which a handler may let escape (a panic or an error it returns up the stack)
// without that making the Preview unsafe.
func isBlockedFailure(err error) bool {
	var blocked *PreviewWriteBlockedError
	return errors.As(err, &blocked)
}

// buildEnvelope assembles the confirmed result after a successful rollback. The
// changes are the SQL provider's followed by those the data stores reported.
func (b *Sendproof) buildEnvelope(capture *captureWriter, session Session, state *requestState, snapshot captureSnapshot) *previewEnvelope {
	var changes []Change
	var providerTruncated bool
	if session != nil {
		changes, providerTruncated = session.Changes(), session.ChangesTruncated()
	}
	state.mu.Lock()
	changes = append(changes, state.changes...)
	storeTruncated := state.changesTruncated
	state.mu.Unlock()
	changes, truncated := snapshotChanges(changes)
	return &previewEnvelope{
		Status: capture.status, Headers: capture.envelopeHeaders(), Body: capture.envelopeBody(),
		Changes: changes, Effects: nonNil(snapshot.Effects), Logs: nonNil(snapshot.Logs), RolledBack: true,
		ChangesTruncated: truncated || providerTruncated || storeTruncated,
		EffectsTruncated: snapshot.EffectsTruncated, LogsTruncated: snapshot.LogsTruncated,
	}
}

// runProtected runs fn and converts a panic into an error, so a failing handler
// still reaches rollback.
func runProtected(fn func()) (failure error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			if err, ok := recovered.(error); ok {
				failure = fmt.Errorf("the handler panicked: %w", err)
				return
			}
			failure = fmt.Errorf("the handler panicked: %v", recovered)
		}
	}()
	fn()
	return nil
}

// protect runs one cleanup step and converts a panic into an error, so a crashing
// store hook or provider never skips the remaining aborts and rollbacks, and the
// Preview answers 500 instead of confirming.
func protect(step string, fn func() error) (failure error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			failure = fmt.Errorf("%s panicked: %v", step, recovered)
		}
	}()
	return fn()
}

// rejectUnexecuted explains why a preview produced no result: the request was
// stopped before the marked handler ran, for example by authentication.
func rejectUnexecuted(w http.ResponseWriter, capture *captureWriter, invoked bool) {
	if invoked {
		reject(w, http.StatusInternalServerError, "The preview operation did not finish.")
		return
	}
	status := capture.status
	if challenge := capture.header.Get("WWW-Authenticate"); challenge != "" {
		w.Header().Set("WWW-Authenticate", challenge)
	}
	var title string
	switch {
	case status == http.StatusUnauthorized:
		title = "Authentication is required for this preview."
	case status == http.StatusForbidden:
		title = "This preview is forbidden."
	case status == http.StatusNotFound || status == http.StatusMethodNotAllowed:
		title = "The preview target was not found for this method."
	case status == http.StatusServiceUnavailable:
		title = "Preview requires one available preview provider."
	case status >= 300 && status < 400:
		title = "Preview redirects are disabled. Sign in through the workbench first."
	case status >= 400 && status < 500 && status != http.StatusConflict:
		title = "The host rejected the preview request."
	default:
		title = "This operation is unavailable for preview."
	}
	if status < 400 || status >= 500 && status != http.StatusServiceUnavailable {
		if status >= 300 && status < 400 {
			status = http.StatusUnauthorized
		} else {
			status = http.StatusConflict
		}
	}
	reject(w, status, title)
}

// enterPreview is the marker's preview step: it checks the route may run, starts
// the provider's session and activates the journal. It writes the rejection status
// and returns false when the handler must not run.
func (s *requestState) enterPreview(w http.ResponseWriter, r *http.Request, op *Operation) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	// The marker must belong to the operation the transport checked: a router
	// rewrite or method override must not swap in another marked operation.
	if s.invoked || op.method != r.Method || op.method != s.method || !op.matches(s.method, s.escaped) {
		w.WriteHeader(http.StatusConflict)
		return false
	}
	if !s.bench.previewReady() {
		w.WriteHeader(http.StatusServiceUnavailable)
		return false
	}
	s.invoked = true
	// The context outlives a disconnected client and carries this Preview, so
	// stores can use the guard and change recording from BeginPreview.
	ctx := context.WithoutCancel(r.Context())
	if provider := s.bench.provider(); provider != nil {
		session, err := provider.Begin(ctx)
		if err != nil || session == nil {
			if errors.Is(err, ErrPreviewUnavailable) {
				s.invoked = false // nothing ran; report the provider's status as is
				w.WriteHeader(http.StatusServiceUnavailable)
				return false
			}
			if err == nil {
				err = errors.New("the preview provider returned no session")
			}
			s.failure = err
			w.WriteHeader(http.StatusInternalServerError)
			return false
		}
		s.session = session
	}
	s.rec.begin(true)
	// Stores begin with the lock released: they call back into the Preview scope.
	s.mu.Unlock()
	var failure error
	var entries []storeEntry
	for _, store := range s.bench.cfg.stores {
		preview, err := store.BeginPreview(ctx)
		if preview != nil {
			entries = append(entries, storeEntry{store: store, preview: preview})
		}
		if err != nil {
			failure = errors.Join(failure, fmt.Errorf("a data store could not begin the preview: %w", err))
			break
		}
	}
	s.mu.Lock()
	s.stores = append(s.stores, entries...)
	if failure != nil {
		s.failure = errors.Join(s.failure, failure)
		w.WriteHeader(http.StatusInternalServerError)
		return false
	}
	return true
}
