package sendproof

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	sessionsPath     = "/sendproof/_api/sessions"
	sessionHeader    = "Sendproof-Session"
	sessionIdle      = 5 * time.Minute
	sessionLifetime  = 30 * time.Minute
	sessionAcquire   = 3 * time.Second
	maxOwnerSessions = 4
	maxHostSessions  = 16
)

type sessionRegistry struct {
	mu     sync.Mutex
	open   map[string]*heldPreview
	closed bool
	active sync.WaitGroup
}

type heldPreview struct {
	id     string
	owner  traceOwner
	next   int
	sql    HeldSQL
	stores []storeEntry
	parts  []HeldTransaction // in acquisition order: SQL first, then data stores

	// The registry lock protects admission, deadlines and disposal.
	busy, closing bool
	idle, expires time.Time
	timer         *time.Timer
}

type sessionPosition struct {
	ID   string `json:"id"`
	Step int    `json:"step"`
}

func (b *Sendproof) sessionsReady(stores []DataStoreInfo) bool {
	if !b.previewReady() {
		return false
	}
	if provider := b.provider(); provider != nil {
		if _, ok := provider.(HeldProvider); !ok {
			return false
		}
	}
	for i, info := range stores {
		if info.Mode == ModePreview {
			if _, ok := b.cfg.stores[i].(HeldStore); !ok {
				return false
			}
		}
	}
	return true
}

func (b *Sendproof) sessionOwner(r *http.Request) (traceOwner, bool) {
	if principal, authenticated := b.principal(r); authenticated {
		return b.principalOwner(principal, b.pathBase(r))
	}
	return traceOwner{pathBase: b.pathBase(r)}, true
}

// Close ends every Preview session and waits for requests already using a session
// to finish. Call it during host shutdown, before closing the underlying stores.
func (b *Sendproof) Close() {
	reg := &b.sessions
	reg.mu.Lock()
	reg.closed = true
	var idle []*heldPreview
	for _, s := range reg.open {
		if !s.busy && !s.closing {
			s.closing = true
			idle = append(idle, s)
		}
	}
	reg.mu.Unlock()
	for _, s := range idle {
		_ = b.disposeSession(s)
	}
	reg.active.Wait()
}

func (b *Sendproof) reserveSession(owner traceOwner) (*heldPreview, string) {
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		return nil, "session_failed"
	}
	reg := &b.sessions
	reg.mu.Lock()
	defer reg.mu.Unlock()
	if reg.closed {
		return nil, "session_failed"
	}
	count := 0
	for _, s := range reg.open {
		if s.owner == owner {
			count++
		}
	}
	if count >= maxOwnerSessions || len(reg.open) >= maxHostSessions {
		return nil, "session_limit"
	}
	s := &heldPreview{id: hex.EncodeToString(id), owner: owner, next: 1, busy: true}
	reg.open[s.id] = s
	reg.active.Add(1)
	return s, ""
}

func (b *Sendproof) enterSession(r *http.Request, id string) (*heldPreview, string) {
	owner, ok := b.sessionOwner(r)
	if !ok || !isSameOrigin(r) {
		return nil, "session_not_found"
	}
	reg := &b.sessions
	reg.mu.Lock()
	defer reg.mu.Unlock()
	s := reg.open[id]
	if s == nil || s.closing || s.expires.IsZero() || reg.closed || s.owner != owner {
		return nil, "session_not_found"
	}
	if s.busy {
		return nil, "session_busy"
	}
	if !time.Now().Before(s.deadline()) {
		return nil, "session_not_found"
	}
	s.busy = true
	s.timer.Stop()
	return s, ""
}

func (s *heldPreview) deadline() time.Time {
	if s.expires.Before(s.idle) {
		return s.expires
	}
	return s.idle
}

func (b *Sendproof) exitSession(s *heldPreview) {
	reg := &b.sessions
	reg.mu.Lock()
	if s.closing {
		reg.mu.Unlock()
		return
	}
	now := time.Now()
	if s.expires.IsZero() {
		s.expires = now.Add(sessionLifetime)
	}
	if reg.closed || !now.Before(s.expires) {
		s.closing = true
		reg.mu.Unlock()
		_ = b.disposeSession(s)
		return
	}
	s.busy = false
	s.idle = now.Add(sessionIdle)
	if s.timer == nil {
		s.timer = time.AfterFunc(time.Until(s.deadline()), func() { b.expireSession(s) })
	} else {
		s.timer.Reset(time.Until(s.deadline()))
	}
	reg.mu.Unlock()
}

func (b *Sendproof) expireSession(s *heldPreview) {
	reg := &b.sessions
	reg.mu.Lock()
	if s.closing || s.busy || time.Now().Before(s.deadline()) {
		reg.mu.Unlock()
		return
	}
	s.closing = true
	reg.mu.Unlock()
	_ = b.disposeSession(s)
}

// endSession is called by the request that exclusively owns s.
func (b *Sendproof) endSession(s *heldPreview) error {
	b.sessions.mu.Lock()
	s.closing = true
	b.sessions.mu.Unlock()
	return b.disposeSession(s)
}

func (b *Sendproof) disposeSession(s *heldPreview) error {
	if s.timer != nil {
		s.timer.Stop()
	}
	var failure error
	for i := len(s.parts) - 1; i >= 0; i-- {
		failure = errors.Join(failure, protect("a held transaction Close", s.parts[i].Close))
	}
	if failure != nil {
		b.cfg.logger.Error("a Sendproof session could not be rolled back", "error", failure)
	}
	b.sessions.mu.Lock()
	delete(b.sessions.open, s.id)
	b.sessions.mu.Unlock()
	b.sessions.active.Done()
	return failure
}

func (s *heldPreview) rewind(ctx context.Context, step int) error {
	var failure error
	for i := len(s.parts) - 1; i >= 0; i-- {
		part := s.parts[i]
		failure = errors.Join(failure, protect("a held transaction Rewind", func() error { return part.Rewind(ctx, step) }))
	}
	return failure
}

func (b *Sendproof) serveSessions(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	path := r.URL.EscapedPath()
	open := path == sessionsPath
	if !isSameOrigin(r) {
		if open {
			reject(w, http.StatusForbidden, "Preview sessions must be opened from the same origin.")
		} else {
			sessionProblem(w, "session_not_found", "")
		}
		return
	}
	if status := b.authorize(r); status != 0 {
		reject(w, status, "Access to the workbench is required.")
		return
	}
	if open {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			reject(w, http.StatusMethodNotAllowed, "Use POST to open a preview session.")
			return
		}
		b.openSession(w, r)
		return
	}
	id, action, hasAction := strings.Cut(strings.TrimPrefix(path, sessionsPath+"/"), "/")
	rewind := action == "rewind" && r.Method == http.MethodPost
	if !rewind && (hasAction || r.Method != http.MethodDelete) {
		sessionProblem(w, "session_not_found", "")
		return
	}
	s, code := b.enterSession(r, id)
	if code != "" {
		sessionProblem(w, code, "")
		return
	}
	defer b.exitSession(s)
	if !rewind {
		if b.endSession(s) != nil {
			reject(w, http.StatusInternalServerError, "The preview session could not be rolled back cleanly.")
			return
		}
	} else {
		var input struct{ Step int }
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
		if err := decoder.Decode(&input); err != nil || decoder.Decode(new(any)) != io.EOF ||
			input.Step < 1 || input.Step > s.next {
			reject(w, http.StatusBadRequest, "Rewind to a step from 1 to the next step of the preview session.")
			return
		}
		if input.Step < s.next {
			if err := s.rewind(context.WithoutCancel(r.Context()), input.Step); err != nil {
				b.failSession(w, s, err)
				return
			}
			s.next = input.Step
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func (b *Sendproof) openSession(w http.ResponseWriter, r *http.Request) {
	owner, ok := b.sessionOwner(r)
	if !ok {
		reject(w, http.StatusForbidden, "A preview session needs a stable subject for the signed-in caller.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), sessionAcquire)
	defer cancel()
	infos := b.dataStores(ctx)
	if !b.sessionsReady(infos) {
		sessionProblem(w, "session_failed", "")
		return
	}
	s, code := b.reserveSession(owner)
	if code != "" {
		sessionProblem(w, code, "")
		return
	}
	label := ""
	err := protect("held transaction acquisition", func() error {
		if provider, ok := b.provider().(HeldProvider); ok {
			label = provider.Database()
			if !IsDisplayLabel(label) {
				label = "the SQL store"
			}
			part, err := provider.BeginHeld(ctx)
			if part != nil {
				s.sql = part
				s.parts = append(s.parts, part)
			}
			if err != nil || part == nil {
				return errors.Join(err, ErrSessionFailed)
			}
		}
		for i, store := range b.cfg.stores {
			if holder, ok := store.(HeldStore); ok {
				label = StoreName(infos[i].System)
				part, err := holder.BeginHeld(ctx)
				if part != nil {
					s.stores = append(s.stores, storeEntry{store, part})
					s.parts = append(s.parts, part)
				}
				if err != nil {
					return err
				}
			}
		}
		return ctx.Err()
	})
	if err != nil {
		_ = b.endSession(s)
		b.cfg.logger.Warn("a Sendproof session could not be opened", "error", err)
		if errors.Is(err, ErrStoreBusy) {
			sessionProblem(w, "store_busy", label)
		} else {
			sessionProblem(w, "session_failed", "")
		}
		return
	}
	b.exitSession(s)
	writeJSON(w, http.StatusCreated, map[string]any{
		"id": s.id, "idleTimeoutSeconds": int(sessionIdle.Seconds()), "maxLifetimeSeconds": int(sessionLifetime.Seconds()),
	})
}

func (b *Sendproof) failSession(w http.ResponseWriter, s *heldPreview, err error) {
	b.cfg.logger.Error("a Sendproof session failed", "error", err)
	_ = b.endSession(s)
	if errors.Is(err, ErrSessionFailed) {
		sessionProblem(w, "session_failed", "")
		return
	}
	reject(w, http.StatusInternalServerError, "The preview session could not be continued safely.")
}

func sessionProblem(w http.ResponseWriter, code, label string) {
	status, title := http.StatusConflict, "A store could not open or continue this Preview session."
	extra := map[string]any{}
	switch code {
	case "session_not_found":
		status, title = http.StatusNotFound, "The preview session was not found."
	case "session_busy":
		title = "The preview session is serving another request."
	case "session_limit":
		status, title = http.StatusTooManyRequests, "Too many preview sessions are open. End one first."
	case "store_busy":
		title = "Another Preview session is holding " + label + "."
		seconds := int(sessionIdle.Seconds())
		extra["idleTimeoutSeconds"] = seconds
		extra["detail"] = fmt.Sprintf("That session ends by itself after its idle timeout (%d seconds), or when it is ended.", seconds)
	}
	extra["type"], extra["title"], extra["status"], extra["code"] = "about:blank", title, status, code
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(extra)
}
