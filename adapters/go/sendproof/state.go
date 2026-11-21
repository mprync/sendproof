package sendproof

import (
	"context"
	"net/http"
	"sync"
	"time"
)

type stateKind int

const (
	kindNone stateKind = iota
	kindPreview
	kindObserved
)

type stateKey struct{}

// requestState is the mutable Sendproof state of one request. The middleware
// creates it, route markers advance it, and data-access wrappers read it through
// the request context. It is shared by pointer so a handler's derived contexts
// all see the same preview session and journal.
type requestState struct {
	mu       sync.Mutex
	bench    *Sendproof
	kind     stateKind
	rec      *recorder
	pathBase string

	// Preview.
	target    string // path the handler must still see after rewriting
	method    string // method the preview was checked for
	escaped   string // escaped target path the preview was checked for
	invoked   bool
	completed bool
	session   Session
	failure   error

	// Observed send.
	owner       traceOwner
	reservation *reservation
	observation Observation
	valid       bool
}

func stateFrom(ctx context.Context) *requestState {
	state, _ := ctx.Value(stateKey{}).(*requestState)
	return state
}

func withState(r *http.Request, state *requestState) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), stateKey{}, state))
}

// IsPreview reports whether ctx belongs to a rollback-only preview. Applications
// can use it to skip work that must not happen during a preview. It also reports
// true while the request runs outside its marked handler, for example in a
// handler the router chose that was never marked, because nothing such code does
// is rolled back.
func IsPreview(ctx context.Context) bool {
	state := stateFrom(ctx)
	return state != nil && state.kind == kindPreview
}

// IsCapturing reports whether a preview or an observed send is recording ctx.
func IsCapturing(ctx context.Context) bool {
	state := stateFrom(ctx)
	return state != nil && state.rec != nil && state.rec.isActive()
}

// PreviewSession returns the preview session that a marked handler runs in, so a
// data-access wrapper can enlist in its transaction. During a preview that has no
// session, because the handler was not marked, it reports ErrNoPreviewSession.
// Outside a preview it returns (nil, nil).
func PreviewSession(ctx context.Context) (Session, error) {
	state := stateFrom(ctx)
	if state == nil || state.kind != kindPreview {
		return nil, nil
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.session == nil {
		return nil, ErrNoPreviewSession
	}
	return state.session, nil
}

// SendObservation returns the observation an observed send runs under, so a
// data-access wrapper can run the request's commands on the connection its
// provider observes. It returns nil outside an observed send, and also when the
// provider does not observe changes.
func SendObservation(ctx context.Context) Observation {
	state := stateFrom(ctx)
	if state == nil || state.kind != kindObserved {
		return nil
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if !state.invoked {
		return nil
	}
	return state.observation
}

// RecordEffect records an intended side effect, such as an email, publication or
// webhook, and returns true when the caller must not perform it. A preview
// suppresses the effect, also when it is registered outside the marked handler
// or after the preview finished. An observed send records it as delivered and
// returns false so the caller proceeds. Outside Sendproof it records nothing and
// returns false. The data value is serialized for display and bounded.
func RecordEffect(ctx context.Context, kind, description string, data any) (suppress bool) {
	state := stateFrom(ctx)
	if state == nil || state.rec == nil {
		return false
	}
	suppress = state.rec.recordEffect(kind, description, data)
	return suppress || state.kind == kindPreview
}

// RecordEmail records an email effect with the conventional data shape and returns
// true when the caller must not send it.
func RecordEmail(ctx context.Context, description, from string, to []string, subject, text string) (suppress bool) {
	return RecordEffect(ctx, "email", description, map[string]any{
		"from": from, "to": nonNil(to), "cc": []string{}, "subject": subject, "text": text,
	})
}

// RecordHTTP records an outbound HTTP call and returns true when the caller must not make it.
func RecordHTTP(ctx context.Context, description, method, url string) (suppress bool) {
	return RecordEffect(ctx, "http", description, map[string]any{"method": method, "url": url})
}

// RecordJob records a background job and returns true when the caller must not enqueue it.
func RecordJob(ctx context.Context, description, name string, arguments any, queue string, runAt time.Time) (suppress bool) {
	data := map[string]any{"name": name, "arguments": arguments}
	if queue != "" {
		data["queue"] = queue
	}
	if !runAt.IsZero() {
		data["runAt"] = runAt.UTC().Format(time.RFC3339)
	}
	return RecordEffect(ctx, "job", description, data)
}

// RecordMessage records a published message and returns true when the caller must not publish it.
func RecordMessage(ctx context.Context, description, topic string, payload any) (suppress bool) {
	return RecordEffect(ctx, "message", description, map[string]any{"topic": topic, "payload": payload})
}

// Log records a log line in the preview or observed trace of ctx and reports
// whether capture is active. Level is a display name such as "Information",
// "Warning" or "Error".
func Log(ctx context.Context, level, message string) bool {
	state := stateFrom(ctx)
	if state == nil || state.rec == nil {
		return false
	}
	return state.rec.recordLog(level, message)
}

// RecordSQL records an executed database command. Data-access wrappers call it so
// the command appears in the log with redacted parameters and counts toward the
// database timing. It does nothing when ctx is not being captured.
func RecordSQL(ctx context.Context, call SQLCall) {
	state := stateFrom(ctx)
	if state == nil || state.rec == nil {
		return
	}
	state.rec.recordSQL(call)
}

func nonNil[T any](values []T) []T {
	if values == nil {
		return []T{}
	}
	return values
}
