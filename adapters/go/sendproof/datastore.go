package sendproof

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// This file is the Go side of spec/data-stores.md: the write guard every data
// store hook calls before it sends a command, the Preview scope fields that
// record a blocked write or a transaction-control fault, the Db log entries and
// document changes of non-SQL stores, and the registration of hooked stores.
//
// The packages redisbench, dynamobench and mongobench build on it. They live in
// modules of their own so applications that do not use a store do not download
// its client library.

// Store modes (spec/data-stores.md, "Store modes").
const (
	// ModePreview marks a store whose writes run in a transaction that Preview aborts.
	ModePreview = "preview"
	// ModeGuard marks a store whose reads run and whose first write blocks the Preview.
	ModeGuard = "guard"
)

// DataStore is a non-SQL store whose client has been hooked. Register it with
// WithDataStore so discovery lists it and Preview can use it. The hook packages
// return implementations; applications rarely implement the interface.
type DataStore interface {
	// Describe reports the store for capabilities `dataStores`. It may contact the
	// store, for example to detect a MongoDB replica set, and must never include a
	// connection string, host name, user or password.
	Describe(ctx context.Context) DataStoreInfo

	// BeginPreview is called as a marked handler enters a Preview, before the
	// handler runs. A store with nothing to prepare returns (nil, nil). The ctx
	// carries the Preview, so the store can use Guard, RefusePreview and the other
	// scope functions in this package.
	BeginPreview(ctx context.Context) (StorePreview, error)
}

// DataStoreInfo is one entry of the capabilities `dataStores` list.
type DataStoreInfo struct {
	// System is the store id: "mongodb", "redis" or "dynamodb".
	System string `json:"system"`
	// Name is an optional host-chosen display label.
	Name string `json:"name,omitempty"`
	// Mode is ModePreview or ModeGuard.
	Mode string `json:"mode"`
	// Reason says why a guard-mode store cannot Preview, when that is not obvious.
	Reason string `json:"reason,omitempty"`
}

// StorePreview is the per-Preview state of a store that runs a transaction.
type StorePreview interface {
	// Finish captures the store's changes (through RecordChange) and aborts its
	// transaction. It runs after the handler and before the SQL rollback. A failure
	// withholds confirmation.
	Finish(ctx context.Context) error

	// Close releases the Preview's resources. It is always called, also after a
	// failed Finish.
	Close() error
}

// WithDataStore registers a hooked data store. With stores registered, a bench
// can Preview without a SQL provider, because every store hook still guards and
// aborts on its own. A bench with several SQL providers still offers no Preview.
func WithDataStore(store DataStore) Option {
	return func(c *config) error {
		if store == nil {
			return errors.New("sendproof: the data store must not be nil")
		}
		c.stores = append(c.stores, store)
		return nil
	}
}

// WithFramework names the web framework for capabilities `binding`, so the
// workbench writes its `preview: false` snippet for it. The default is "net/http".
func WithFramework(name string) Option {
	return func(c *config) error {
		if strings.TrimSpace(name) == "" {
			return errors.New("sendproof: the framework name must not be empty")
		}
		c.framework = name
		return nil
	}
}

// StoreNames are the display names used in "Preview unavailable: this operation
// writes to <Store>".
var storeNames = map[string]string{"mongodb": "MongoDB", "redis": "Redis", "dynamodb": "DynamoDB"}

// StoreName returns the display name of a store id; an unknown id is returned as given.
func StoreName(store string) string {
	if name, ok := storeNames[store]; ok {
		return name
	}
	return store
}

// WriteReason is the sentence shown when the guard refuses a write to a store.
func WriteReason(store string) string {
	return "Preview unavailable: this operation writes to " + StoreName(store)
}

// PreviewWriteBlockedError is returned to the handler when the guard refuses a
// write during a Preview. No byte of the command reached the store. The Preview
// answers 409 whatever the handler does with the error.
type PreviewWriteBlockedError struct {
	// Store is the store id, such as "redis".
	Store string
	// Operation is the refused command or action name, never its arguments.
	Operation string
	// Reason is the sentence the workbench shows.
	Reason string
}

func (e *PreviewWriteBlockedError) Error() string { return e.Reason }

// PreviewTransactionControlError is returned when a handler tries to end or
// escape the Preview transaction: a raw SQL COMMIT, a MongoDB commitTransaction,
// or a command sent with a session other than the Preview's. The Preview answers
// 500 without confirmation even when the handler ignores the error.
type PreviewTransactionControlError struct{ Reason string }

func (e *PreviewTransactionControlError) Error() string { return e.Reason }

// blockedWrite is the first refused write of a Preview.
type blockedWrite struct{ store, operation, detail string }

// Guard is the single decision point every store hook calls before it sends a
// command. write says whether the hook's classifier judged the command a write.
//
// It does nothing for a read or outside a Preview, so Send and observed Send are
// never blocked. For a write in a Preview it records the block on the request,
// logs a blocked Db entry and returns a *PreviewWriteBlockedError, which the hook
// must return to the handler without sending the command. The record, not what
// the handler does with the error, decides the outcome. detail replaces the
// default "writes to <Store>" reason, for example for a MongoDB command that
// cannot run inside a transaction.
//
// Guard works for any context derived from the request, also after the Preview
// finished and in handlers that were never marked, so a late write is still refused.
// A write whose context belongs to no request is let through, but fails every
// open Preview with 500 (see ReportWrite).
func Guard(ctx context.Context, store, operation string, write bool, detail string) error {
	state := stateFrom(ctx)
	if write && state == nil {
		ReportWrite(ctx, store, operation)
	}
	if !write || state == nil || state.kind != kindPreview {
		return nil
	}
	if detail == "" {
		detail = WriteReason(store)
	}
	state.mu.Lock()
	if state.blocked == nil {
		state.blocked = &blockedWrite{store: clip(store, maxName), operation: clip(operation, maxName), detail: clip(detail, maxText)}
	}
	state.mu.Unlock()
	if state.rec != nil {
		state.rec.recordDb(DbCall{System: store, Operation: operation, Blocked: true})
	}
	return &PreviewWriteBlockedError{Store: store, Operation: operation, Reason: detail}
}

// RefusePreview records that a handler tried to end or escape the Preview
// transaction and returns the error the hook must return. The Preview answers
// 500 without confirmation. Outside a Preview it returns nil and records nothing.
func RefusePreview(ctx context.Context, reason string) error {
	state := stateFrom(ctx)
	if state == nil || state.kind != kindPreview {
		return nil
	}
	err := &PreviewTransactionControlError{Reason: reason}
	state.mu.Lock()
	if state.fault == nil {
		state.fault = err
	}
	state.mu.Unlock()
	return err
}

// BlockPreview records a refusal the store reported itself: for example the
// server's reply that a command cannot run in a transaction. The Preview answers
// 409 with the reason, as if the guard had refused the command first.
func BlockPreview(ctx context.Context, store, operation, reason string) {
	state := stateFrom(ctx)
	if state == nil || state.kind != kindPreview {
		return
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.blocked == nil {
		state.blocked = &blockedWrite{store: clip(store, maxName), operation: clip(operation, maxName), detail: clip(reason, maxText)}
	}
}

// PreviewStore returns the per-Preview state a store prepared in BeginPreview,
// so a data-access wrapper can enlist in it. It returns nil outside a Preview,
// in a handler that was not marked, and for a store with no state.
func PreviewStore(ctx context.Context, store DataStore) StorePreview {
	state := stateFrom(ctx)
	if state == nil || state.kind != kindPreview {
		return nil
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	for _, entry := range state.stores {
		if entry.store == store {
			return entry.preview
		}
	}
	return nil
}

// RecordChange records a document, item or key change of a Preview. Values are
// JSON-serializable; secret-named fields are redacted at any depth. It does
// nothing outside a Preview.
func RecordChange(ctx context.Context, change Change) {
	state := stateFrom(ctx)
	if state == nil || state.kind != kindPreview {
		return
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if len(state.changes) > MaxChanges {
		state.changesTruncated = true
		return
	}
	state.changes = append(state.changes, change)
}

// TruncateChanges marks the Preview's changes as incomplete, for a store that
// stopped reading candidates at its own limit.
func TruncateChanges(ctx context.Context) {
	if state := stateFrom(ctx); state != nil && state.kind == kindPreview {
		state.mu.Lock()
		state.changesTruncated = true
		state.mu.Unlock()
	}
}

// DbCall describes one command sent to a non-SQL store, for the Db log entry.
// Statement must already be sanitized: values never appear in a capture.
type DbCall struct {
	// System is the store id: "mongodb", "redis", "dynamodb".
	System string
	// Operation is the command or action name: "find", "INCR", "PutItem".
	Operation string
	// Target is the collection or table, or the first key for Redis.
	Target string
	// Namespace is the MongoDB database or the Redis database number.
	Namespace string
	// Statement is the sanitized command text.
	Statement string
	// RowsAffected is the documents or items matched, modified or returned, or -1 when unknown.
	RowsAffected int64
	// Duration is how long the command took.
	Duration time.Duration
	// Blocked marks the entry for a command the guard refused.
	Blocked bool
	// Error is the store's error code name, such as "WriteConflict".
	Error string
}

// RecordDb records a command to a non-SQL store as a Db log entry. It counts
// toward the database timing unless the command was blocked. Does nothing when
// ctx is not being captured.
func RecordDb(ctx context.Context, call DbCall) {
	state := stateFrom(ctx)
	if state == nil || state.rec == nil {
		return
	}
	state.rec.recordDb(call)
}

// dbEntry is the `db` object of a Db log entry (OpenTelemetry database attributes).
type dbEntry struct {
	System       string `json:"system"`
	Namespace    string `json:"namespace,omitempty"`
	Operation    string `json:"operation"`
	Target       string `json:"target,omitempty"`
	Statement    string `json:"statement,omitempty"`
	RowsAffected *int64 `json:"rowsAffected,omitempty"`
	Blocked      bool   `json:"blocked,omitempty"`
	Error        string `json:"error,omitempty"`
}

// recordDb stores one Db entry.
func (r *recorder) recordDb(call DbCall) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.active {
		return
	}
	duration := float64(call.Duration) / float64(time.Millisecond)
	if !call.Blocked {
		r.dbMs += duration
		if r.queries < int(^uint(0)>>1) {
			r.queries++
		}
	}
	if !r.hasLogRoom() {
		return
	}
	entry := dbEntry{
		System: r.clipLog(call.System, maxName), Operation: r.clipLog(call.Operation, maxName),
		Target: r.clipLog(call.Target, maxName), Namespace: r.clipLog(call.Namespace, maxName),
		Statement: r.clipLog(call.Statement, maxText), Blocked: call.Blocked, Error: r.clipLog(call.Error, maxName),
	}
	if call.RowsAffected >= 0 && call.Error == "" && !call.Blocked {
		rows := call.RowsAffected
		entry.RowsAffected = &rows
	}
	message := entry.Operation
	if entry.Target != "" {
		message += " " + entry.Target
	}
	offset := r.offsetMs() - duration
	if offset < 0 {
		offset = 0
	}
	log := previewLog{Level: "Db", Message: message, OffsetMs: &offset, DB: &entry}
	if !call.Blocked {
		log.ElapsedMs = &duration
	}
	r.addLog(log)
}

// UnknownRows is the DbCall.RowsAffected value for a reply that does not say how
// many documents or items were involved. Zero is a real count.
const UnknownRows int64 = -1

// ---- Unavailable operations (`preview: false`) ----

// unavailable is an operation an API author marked `preview: false`.
type unavailable struct {
	method, path, reason string
	stores               []string
}

// UnavailableOption refines an operation marked unavailable for Preview.
type UnavailableOption func(*unavailable)

// ForStores names the stores the operation writes, as store ids such as "redis".
// With no explicit reason, the first store's "writes to <Store>" sentence is used.
func ForStores(stores ...string) UnavailableOption {
	return func(u *unavailable) { u.stores = append(u.stores, stores...) }
}

var storeID = regexp.MustCompile(`^[a-z][a-z0-9]*$`)

// Unavailable marks an operation `preview: false`: the workbench shows the reason
// before the user tries, Preview of it is refused (HTTP 409, the handler does not
// run) and Send keeps working. Use it with routers that register handlers
// themselves; HandleUnavailable registers the route as well. The path is the
// OpenAPI template, as for Operation. It panics on an empty reason without stores
// or a malformed store id, because both are programming errors.
func (b *Sendproof) Unavailable(method, path, reason string, options ...UnavailableOption) {
	template, _ := normalizeTemplate(path)
	op := &unavailable{method: strings.ToUpper(method), path: template, reason: strings.TrimSpace(reason)}
	for _, option := range options {
		option(op)
	}
	for _, store := range op.stores {
		if !storeID.MatchString(store) {
			panic(fmt.Sprintf("sendproof: %q is not a store id such as \"redis\"", store))
		}
	}
	if op.reason == "" && len(op.stores) > 0 {
		op.reason = WriteReason(op.stores[0])
	}
	if op.reason == "" || len(op.reason) > 512 {
		panic("sendproof: give an unavailable operation a reason of at most 512 bytes, or the stores it writes")
	}
	b.mu.Lock()
	b.unavailable = append(b.unavailable, op)
	b.mu.Unlock()
}

// HandleUnavailable registers handler on the router under a "METHOD /path"
// pattern and marks the operation `preview: false` with a reason. The route is
// not marked for Preview, so a Preview of it finds no operation and the handler
// never runs; Send is unaffected. It is the counterpart of HandlePreview.
func (b *Sendproof) HandleUnavailable(router Router, pattern, reason string, handler http.Handler, options ...UnavailableOption) {
	method, path, found := strings.Cut(pattern, " ")
	if !found || !strings.HasPrefix(strings.TrimSpace(path), "/") {
		panic("sendproof: HandleUnavailable needs a \"METHOD /path\" pattern, got " + pattern)
	}
	b.Unavailable(method, strings.TrimSpace(path), reason, options...)
	router.Handle(pattern, handler)
}

// previewUnavailable lists the operations marked unavailable, in registration order.
func (b *Sendproof) previewUnavailable() []map[string]any {
	b.mu.RLock()
	defer b.mu.RUnlock()
	result := make([]map[string]any, 0, len(b.unavailable))
	for _, op := range b.unavailable {
		entry := map[string]any{"method": op.method, "path": op.path, "reason": op.reason}
		if len(op.stores) > 0 {
			entry["stores"] = op.stores
		}
		result = append(result, entry)
	}
	return result
}

// ---- Discovery and the blocked response ----

// dataStores lists the registered stores for capabilities.
func (b *Sendproof) dataStores(ctx context.Context) []DataStoreInfo {
	infos := make([]DataStoreInfo, 0, len(b.cfg.stores))
	for _, store := range b.cfg.stores {
		info := store.Describe(ctx)
		if info.Name != "" && !IsDisplayLabel(info.Name) {
			info.Name = ""
		}
		infos = append(infos, info)
	}
	return infos
}

// previewReady reports whether Preview can run: exactly one SQL provider, or no
// provider and at least one hooked store. With several providers the bench cannot
// tell which one owns a request.
func (b *Sendproof) previewReady() bool {
	switch len(b.cfg.providers) {
	case 0:
		return len(b.cfg.stores) > 0
	case 1:
		return true
	}
	return false
}

// serveBlocked answers a blocked Preview: HTTP 409 with an RFC 9457 problem body,
// no confirmation header, and nothing the handler produced. It names the command,
// never its arguments.
func serveBlocked(w http.ResponseWriter, blocked blockedWrite) {
	headers := w.Header()
	headers.Set("Cache-Control", "no-store")
	headers.Set("Content-Type", "application/problem+json")
	w.WriteHeader(http.StatusConflict)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"type": "about:blank", "title": "Preview unavailable", "status": http.StatusConflict,
		"code": "preview_unavailable", "detail": blocked.detail, "store": blocked.store,
		"operation": blocked.operation, "rolledBack": false,
	})
}
