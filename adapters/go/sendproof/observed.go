package sendproof

import (
	"context"
	"net/http"
	"time"
)

// observedWriter adds the trace headers to an observed send's real response when
// its headers are written, which is the last moment they can still be set.
type observedWriter struct {
	http.ResponseWriter
	state *requestState
	wrote bool
}

func (o *observedWriter) WriteHeader(status int) {
	if !o.wrote && (status >= 200 || status == http.StatusSwitchingProtocols) {
		o.wrote = true
		o.state.mu.Lock()
		if o.state.reservation != nil && o.state.valid {
			headers := o.ResponseWriter.Header()
			headers.Set(traceHeader, o.state.reservation.id)
			headers.Set("Cache-Control", "no-store")
			headers.Set(serverTimingName, o.state.rec.timing(0).header())
		}
		o.state.mu.Unlock()
	}
	o.ResponseWriter.WriteHeader(status)
}

func (o *observedWriter) Write(data []byte) (int, error) {
	if !o.wrote {
		o.WriteHeader(http.StatusOK)
	}
	return o.ResponseWriter.Write(data)
}

// Flush forwards to the underlying writer so streaming handlers keep working.
func (o *observedWriter) Flush() {
	if !o.wrote {
		o.WriteHeader(http.StatusOK)
	}
	http.NewResponseController(o.ResponseWriter).Flush() //nolint:errcheck // flushing is best effort
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (o *observedWriter) Unwrap() http.ResponseWriter { return o.ResponseWriter }

// enterObserved is the marker's observed-send step. It never changes the outcome
// of the request: whenever tracing cannot start, the handler simply runs.
func (s *requestState) enterObserved(r *http.Request, op *Operation) {
	if op.method != r.Method {
		return
	}
	bench := s.bench
	s.mu.Lock()
	if s.invoked {
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	owner, ok := bench.owner(r)
	if !ok || bench.authorize(r) != 0 {
		return
	}
	provider := bench.provider()
	if provider == nil {
		return
	}
	var observation Observation
	if observing, ok := provider.(ObservingProvider); ok {
		var err error
		if observation, err = observing.Observe(context.WithoutCancel(r.Context())); err != nil {
			bench.cfg.logger.Warn("Sendproof could not start observing the send", "error", err)
			return
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.invoked, s.owner, s.observation, s.valid = true, owner, observation, true
	s.reservation = bench.traces.reserve(owner)
	s.rec.begin(false)
}

// finishObserved stores the trace of an observed send, or discards its slot when
// the send did not complete. It runs after the handler returns or panics.
func (b *Sendproof) finishObserved(r *http.Request, state *requestState) {
	state.mu.Lock()
	invoked, reservation, observation, completed := state.invoked, state.reservation, state.observation, state.completed
	state.mu.Unlock()
	if !invoked || reservation == nil {
		return
	}
	state.rec.endHandler()
	snapshot := state.rec.finish()
	stored := false
	defer func() {
		if !stored {
			state.mu.Lock()
			state.valid = false
			state.mu.Unlock()
			b.traces.discard(reservation)
		}
		if observation != nil {
			if err := observation.Close(); err != nil {
				b.cfg.logger.Warn("Sendproof could not release the send observation", "error", err)
			}
		}
	}()
	if !completed || r.Context().Err() != nil {
		return
	}
	started := time.Now()
	var changes []Change
	var truncated bool
	if observation != nil {
		var err error
		if changes, truncated, err = observation.Finish(context.WithoutCancel(r.Context())); err != nil {
			b.cfg.logger.Warn("Sendproof could not collect the observed send", "error", err)
			return
		}
	}
	captured, changesTruncated := snapshotChanges(changes)
	timing := state.rec.timing(float64(time.Since(started)) / float64(time.Millisecond))
	reservation.settle(&trace{
		Changes: captured, Effects: nonNil(snapshot.Effects), Logs: nonNil(snapshot.Logs), Timing: timing,
		ChangesTruncated: changesTruncated || truncated,
		EffectsTruncated: snapshot.EffectsTruncated, LogsTruncated: snapshot.LogsTruncated,
	})
	stored = true
}
