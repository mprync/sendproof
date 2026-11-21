package fixture

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"sync"

	"github.com/test-bench/test-bench/adapters/go/testbench"
)

const sessionCookie = "bench_session"

// persona is a development account the fixture can sign in as.
type persona struct {
	Email string `json:"email"`
	Name  string `json:"name"`
	Role  string `json:"role"`
}

var personas = []persona{
	{Email: "admin@example.test", Name: "Fixture Admin", Role: "admin"},
	{Email: "viewer@example.test", Name: "Fixture Viewer", Role: "viewer"},
}

// sessions is an in-memory cookie session store.
type sessions struct {
	mu     sync.Mutex
	tokens map[string]persona
}

func newSessions() *sessions { return &sessions{tokens: map[string]persona{}} }

func (s *sessions) start(w http.ResponseWriter, who persona) {
	var raw [16]byte
	_, _ = rand.Read(raw[:])
	token := hex.EncodeToString(raw[:])
	s.mu.Lock()
	s.tokens[token] = who
	s.mu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: token, Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode})
}

func (s *sessions) who(r *http.Request) (persona, bool) {
	cookie, err := r.Cookie(sessionCookie)
	if err != nil {
		return persona{}, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	who, ok := s.tokens[cookie.Value]
	return who, ok
}

// principal adapts a session to the identity Test Bench reads.
func (s *sessions) principal(r *http.Request) (testbench.Principal, bool) {
	who, ok := s.who(r)
	if !ok {
		return testbench.Principal{}, false
	}
	return testbench.Principal{Subject: who.Email, Name: who.Name, Role: who.Role, Scheme: "cookie"}, true
}

// require returns middleware that answers 401 to anonymous callers and 403 when
// the signed-in user lacks the role. An empty role admits any signed-in user.
func (s *sessions) require(role string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			who, ok := s.who(r)
			switch {
			case !ok:
				writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "sign in first"})
			case role != "" && who.Role != role:
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
			default:
				next.ServeHTTP(w, r)
			}
		})
	}
}

// registerAuth adds the sign-in and persona endpoints to mux.
func (s *sessions) registerAuth(mux *http.ServeMux) {
	mux.HandleFunc("POST /auth/sign-in", func(w http.ResponseWriter, r *http.Request) {
		var credentials struct{ Email, Password string }
		if json.NewDecoder(r.Body).Decode(&credentials) != nil || credentials.Email != "admin@example.test" || credentials.Password != "bench-fixture" {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid credentials"})
			return
		}
		s.start(w, personas[0])
		writeJSON(w, http.StatusOK, personas[0])
	})
	mux.Handle("GET /auth/personas", s.require("admin")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, personas)
	})))
	mux.Handle("POST /auth/personas/{email}", s.require("admin")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		email, err := url.PathUnescape(strings.TrimPrefix(r.URL.EscapedPath(), "/auth/personas/"))
		for _, candidate := range personas {
			if err == nil && candidate.Email == email {
				s.start(w, candidate)
				writeJSON(w, http.StatusOK, candidate)
				return
			}
		}
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown persona"})
	})))
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
