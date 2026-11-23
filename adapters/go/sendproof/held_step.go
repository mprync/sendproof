package sendproof

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"time"
)

func (s *requestState) beginHeldStep(ctx context.Context, w http.ResponseWriter) bool {
	s.mu.Lock()
	if s.invoked {
		s.mu.Unlock()
		w.WriteHeader(http.StatusConflict)
		return false
	}
	s.invoked = true
	s.mu.Unlock()

	held := s.held
	s.rec.begin(true)
	err := protect("a held transaction StartStep", func() error {
		for _, part := range held.parts {
			if err := part.StartStep(ctx, held.next); err != nil {
				return err
			}
		}
		return nil
	})
	s.mu.Lock()
	s.stores = append(s.stores, held.stores...)
	s.session = held.sql
	s.mu.Unlock()
	if err == nil {
		err = s.beginStores(context.WithoutCancel(ctx), held.stores)
	}
	if err != nil {
		s.mu.Lock()
		s.failure = err
		s.mu.Unlock()
		w.WriteHeader(http.StatusInternalServerError)
	}
	return err == nil
}

func (b *Sendproof) serveHeldStep(w http.ResponseWriter, r *http.Request, router http.Handler, state *requestState, s *heldPreview) {
	capture, handlerErr := dispatchPreview(r, router, state)
	state.mu.Lock()
	state.sealed = true
	invoked, completed, beginErr := state.invoked, state.completed, state.failure
	state.mu.Unlock()
	if !invoked {
		if handlerErr != nil {
			reject(w, http.StatusInternalServerError, "The preview operation did not finish.")
		} else {
			rejectUnexecuted(w, capture, false)
		}
		return
	}
	defer state.rec.finish()
	ctx := context.WithValue(context.WithoutCancel(r.Context()), stateKey{}, state)
	// Ordinary per-request guard state is finished here. Held stores keep their
	// transaction and capture or undo this step separately.
	for _, entry := range state.stores {
		if slices.ContainsFunc(s.stores, func(held storeEntry) bool { return held.store == entry.store }) {
			continue
		}
		beginErr = errors.Join(beginErr, protect("a data store Finish", func() error { return entry.preview.Finish(ctx) }),
			protect("a data store Close", entry.preview.Close))
	}
	blocked, fault := state.outcome()
	if err := errors.Join(beginErr, fault); err != nil {
		b.failSession(w, s, err)
		return
	}
	refused := capture.status == http.StatusUnauthorized || capture.status == http.StatusForbidden
	keep := handlerErr == nil && completed && blocked == nil && !capture.exceeded && !refused &&
		capture.status < http.StatusInternalServerError && r.Context().Err() == nil
	var encoded []byte
	var stepErr error
	serialized := time.Now()
	if keep {
		for i := len(s.parts) - 1; i >= 0; i-- {
			part := s.parts[i]
			if stepErr = protect("a held transaction CaptureStep", func() error { return part.CaptureStep(ctx) }); stepErr != nil {
				break
			}
		}
		_, fault := state.outcome()
		if err := errors.Join(fault, stepErr); fault != nil || errors.Is(err, ErrSessionFailed) {
			b.failSession(w, s, err)
			return
		}
		if stepErr == nil {
			envelope := b.buildEnvelope(capture, s.sql, state, state.rec.finish())
			envelope.Session = &sessionPosition{ID: s.id, Step: s.next}
			serialized = time.Now()
			encoded, stepErr = json.Marshal(envelope)
		}
	}
	if encoded != nil && stepErr == nil && r.Context().Err() == nil {
		s.next++
		writePreviewEnvelope(w, state, encoded, serialized)
		return
	}
	if err := s.rewind(ctx, s.next); err != nil {
		b.failSession(w, s, err)
		return
	}
	if r.Context().Err() != nil {
		return
	}
	if refused && handlerErr == nil && stepErr == nil && blocked == nil {
		rejectUnexecuted(w, capture, false)
		return
	}
	b.finishPreviewResponse(w, r, state, capture, nil, errors.Join(handlerErr, stepErr), nil, handlerErr, nil, true)
}

// beginStores opens the request-scoped stores alongside any held transactions.
// The returned states are recorded one at a time so cleanup also sees a partial open.
func (s *requestState) beginStores(ctx context.Context, held []storeEntry) error {
	return protect("a data store BeginPreview", func() error {
		for _, store := range s.bench.cfg.stores {
			if slices.ContainsFunc(held, func(entry storeEntry) bool { return entry.store == store }) {
				continue
			}
			preview, err := store.BeginPreview(ctx)
			if preview != nil {
				s.mu.Lock()
				s.stores = append(s.stores, storeEntry{store, preview})
				s.mu.Unlock()
			}
			if err != nil {
				return fmt.Errorf("a data store could not begin the preview: %w", err)
			}
		}
		return nil
	})
}
