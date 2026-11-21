package sendproof

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"strings"
	"sync"
	"time"
)

const (
	tracesPerOwner = 8
	tracesTotal    = 32
	traceWait      = 5 * time.Second
)

// trace is the result of one observed send, in the wire format of the trace schema.
type trace struct {
	Changes          []Change        `json:"changes"`
	Effects          []previewEffect `json:"effects"`
	Logs             []previewLog    `json:"logs"`
	Timing           captureTiming   `json:"timing"`
	ChangesTruncated bool            `json:"changesTruncated,omitempty"`
	EffectsTruncated bool            `json:"effectsTruncated,omitempty"`
	LogsTruncated    bool            `json:"logsTruncated,omitempty"`
}

// traceOwner identifies who may read a trace: one authenticated subject within one
// authentication scheme and mount prefix.
type traceOwner struct {
	scheme, issuer, subject, pathBase string
}

// reservation is a trace slot that is filled when the observed send finishes.
type reservation struct {
	id      string
	owner   traceOwner
	start   time.Time
	done    chan struct{}
	trace   *trace
	settled sync.Once
}

// settle fills the slot once. A nil trace marks it discarded.
func (r *reservation) settle(result *trace) {
	r.settled.Do(func() {
		r.trace = result
		close(r.done)
	})
}

// traceStore keeps recent traces for their owners. Expiry is evaluated on use, so
// an idle bench holds at most tracesTotal small entries and starts no goroutines.
type traceStore struct {
	mu      sync.Mutex
	entries []*reservation
	ttl     time.Duration
	now     func() time.Time
}

func newTraceStore(ttl time.Duration, now func() time.Time) *traceStore {
	return &traceStore{ttl: ttl, now: now}
}

// reserve allocates a slot for owner, evicting the owner's oldest trace beyond the
// per-owner limit and the oldest overall beyond the total limit.
func (s *traceStore) reserve(owner traceOwner) *reservation {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expire()
	owned := 0
	for _, entry := range s.entries {
		if entry.owner == owner {
			owned++
		}
	}
	if owned >= tracesPerOwner {
		for _, entry := range s.entries {
			if entry.owner == owner {
				s.remove(entry)
				break
			}
		}
	}
	if len(s.entries) >= tracesTotal {
		s.remove(s.entries[0])
	}
	var raw [16]byte
	_, _ = rand.Read(raw[:])
	entry := &reservation{id: hex.EncodeToString(raw[:]), owner: owner, start: s.now(), done: make(chan struct{})}
	s.entries = append(s.entries, entry)
	return entry
}

// read returns the owner's trace, waiting briefly while the send is still finishing.
func (s *traceStore) read(ctx context.Context, id string, owner traceOwner) *trace {
	id = strings.ReplaceAll(strings.ToLower(id), "-", "")
	s.mu.Lock()
	s.expire()
	var found *reservation
	for _, entry := range s.entries {
		if entry.id == id && entry.owner == owner {
			found = entry
			break
		}
	}
	s.mu.Unlock()
	if found == nil {
		return nil
	}
	timer := time.NewTimer(traceWait)
	defer timer.Stop()
	select {
	case <-found.done:
		return found.trace
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return nil
	}
}

func (s *traceStore) discard(entry *reservation) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.remove(entry)
}

// expire drops entries older than the lifetime. The caller holds the lock.
func (s *traceStore) expire() {
	now := s.now()
	for len(s.entries) > 0 && now.Sub(s.entries[0].start) >= s.ttl {
		s.remove(s.entries[0])
	}
}

// remove deletes an entry and releases anyone waiting on it. The caller holds the lock.
func (s *traceStore) remove(entry *reservation) {
	for index, candidate := range s.entries {
		if candidate == entry {
			s.entries = append(s.entries[:index], s.entries[index+1:]...)
			break
		}
	}
	entry.settle(nil)
}
