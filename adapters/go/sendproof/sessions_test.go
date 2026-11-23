package sendproof

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type closeProbe struct {
	HeldTransaction
	closed int
}

func (p *closeProbe) Close() error {
	p.closed++
	return nil
}

func TestSessionRegistryLimitsAndCleanup(t *testing.T) {
	b, err := New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(b.Close)
	var probes []*closeProbe
	var sessions []*heldPreview
	for _, owner := range []string{"a", "b", "c", "d"} {
		for i := 0; i < 4; i++ {
			s, code := b.reserveSession(traceOwner{subject: owner})
			if code != "" {
				t.Fatalf("reserve %s session %d: %s", owner, i, code)
			}
			probe := &closeProbe{}
			probes = append(probes, probe)
			sessions = append(sessions, s)
			s.parts = []HeldTransaction{probe}
			b.exitSession(s)
		}
		if _, code := b.reserveSession(traceOwner{subject: owner}); code != "session_limit" {
			t.Fatalf("owner limit: %s", code)
		}
	}
	if _, code := b.reserveSession(traceOwner{subject: "e"}); code != "session_limit" {
		t.Fatalf("host limit: %s", code)
	}
	expired := sessions[0]
	b.sessions.mu.Lock()
	expired.idle = time.Now().Add(-time.Second)
	b.sessions.mu.Unlock()
	b.expireSession(expired)
	if probes[0].closed != 1 {
		t.Fatal("idle expiry must close the transaction")
	}
	if s, code := b.reserveSession(traceOwner{subject: "e"}); code != "" {
		t.Fatalf("expired session did not free capacity: %s", code)
	} else {
		b.exitSession(s)
	}
	b.Close()
	for index, probe := range probes {
		if probe.closed != 1 {
			t.Errorf("transaction %d closed %d times", index, probe.closed)
		}
	}
}

func TestSessionLifetimeWaitsForActiveStep(t *testing.T) {
	b, err := New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(b.Close)
	s, code := b.reserveSession(traceOwner{})
	if code != "" {
		t.Fatal(code)
	}
	probe := &closeProbe{}
	s.parts = []HeldTransaction{probe}
	b.exitSession(s)
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	if _, code := b.enterSession(r, s.id); code != "" {
		t.Fatal(code)
	}
	b.sessions.mu.Lock()
	s.expires = time.Now().Add(-time.Second)
	b.sessions.mu.Unlock()
	b.expireSession(s)
	if probe.closed != 0 {
		t.Fatal("expiry interrupted an active step")
	}
	b.exitSession(s)
	if _, code := b.enterSession(r, s.id); code != "session_not_found" || probe.closed != 1 {
		t.Fatalf("expired transaction was kept: %s, closes=%d", code, probe.closed)
	}
}

type failedHeldProvider struct{ Provider }

func (failedHeldProvider) Database() string { return "fixture" }
func (failedHeldProvider) BeginHeld(context.Context) (HeldSQL, error) {
	return nil, ErrSessionFailed
}

func TestOpenSessionAdmission(t *testing.T) {
	b, err := New(WithEnvironment("Development"), WithProvider(failedHeldProvider{}),
		WithPrincipal(func(r *http.Request) (Principal, bool) {
			return Principal{}, r.Header.Get("X-Caller") != ""
		}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(b.Close)
	handler := b.Middleware(http.NotFoundHandler())
	for _, example := range []struct {
		name, header, value string
		status              int
	}{
		{"foreign origin", "Origin", "https://other.example", 403},
		{"unstable subject", "X-Caller", "authenticated", 403},
		{"acquisition failure", "", "", 409},
	} {
		t.Run(example.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, sessionsPath, nil)
			if example.header != "" {
				r.Header.Set(example.header, example.value)
			}
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != example.status || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("got %d %s", w.Code, w.Body)
			}
		})
	}
}
