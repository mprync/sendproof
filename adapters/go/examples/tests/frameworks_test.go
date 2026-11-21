package tests

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/test-bench/test-bench/adapters/go/examples/fixture"
)

// TestEveryFrameworkAndStore runs the key protocol checks against each binding
// on every available database. The full protocol suite is tests/conformance/run.mjs.
func TestEveryFrameworkAndStore(t *testing.T) {
	for _, e := range allEngines {
		t.Run(e.name, func(t *testing.T) {
			if e.variable != "" && os.Getenv(e.variable) == "" {
				t.Skipf("set %s to run the %s fixture", e.variable, e.name)
			}
			for _, framework := range []string{"nethttp", "chi", "gin", "echo"} {
				for _, store := range []string{"sql", "gorm"} {
					t.Run(framework+"/"+store, func(t *testing.T) { exercise(t, framework, store, fixtureDatabase(t, e)) })
				}
			}
		})
	}
}

// TestRollbackFailureWithholdsConfirmation checks the rollback-failure scenario
// on every available database: the real rollback runs, the preview is not
// confirmed and nothing persists.
func TestRollbackFailureWithholdsConfirmation(t *testing.T) {
	for _, e := range allEngines {
		t.Run(e.name, func(t *testing.T) {
			if e.variable != "" && os.Getenv(e.variable) == "" {
				t.Skipf("set %s to run the %s fixture", e.variable, e.name)
			}
			for _, store := range []string{"sql", "gorm"} {
				t.Run(store, func(t *testing.T) {
					handler, cleanup, err := fixture.New(fixture.Config{Store: store, Scenario: "rollback-failure", Database: fixtureDatabase(t, e)})
					if err != nil {
						t.Fatal(err)
					}
					t.Cleanup(cleanup)
					cookie := signIn(t, handler, "")
					request := httptest.NewRequest("POST", "/bench/_preview/items", strings.NewReader(`{"id":"r1","name":"Rolled back"}`))
					request.Header.Set("Cookie", cookie)
					request.Header.Set("Prefer", "tx=rollback")
					response := httptest.NewRecorder()
					handler.ServeHTTP(response, request)
					if response.Code == 200 || strings.Contains(response.Body.String(), `"rolledBack":true`) {
						t.Errorf("a failed rollback was confirmed: %d %s", response.Code, response.Body)
					}
					read := httptest.NewRecorder()
					readRequest := httptest.NewRequest("GET", "/items/r1", nil)
					readRequest.Header.Set("Cookie", cookie)
					handler.ServeHTTP(read, readRequest)
					if read.Code != 404 {
						t.Errorf("the preview persisted: %d", read.Code)
					}
				})
			}
		})
	}
}

// fixtureDatabase returns a fresh database of the engine for one fixture.
func fixtureDatabase(t *testing.T, e engine) fixture.Database {
	t.Helper()
	database := fixture.Database{Engine: e.name, Directory: t.TempDir()}
	if e.variable != "" {
		database.URL = freshDatabase(t, e, os.Getenv(e.variable))
	}
	return database
}

func signIn(t *testing.T, handler http.Handler, base string) string {
	t.Helper()
	request := httptest.NewRequest("POST", base+"/auth/sign-in", strings.NewReader(`{"email":"admin@example.test","password":"bench-fixture"}`))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	cookie := strings.SplitN(response.Header().Get("Set-Cookie"), ";", 2)[0]
	if response.Code != 200 || cookie == "" {
		t.Fatalf("sign-in %d", response.Code)
	}
	return cookie
}

func exercise(t *testing.T, framework, store string, database fixture.Database) {
	handler, cleanup, err := fixture.New(fixture.Config{Framework: framework, Store: store, PathBase: "/tenant", Database: database})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(cleanup)
	do := func(method, path, body, cookie string, headers ...string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(method, path, strings.NewReader(body))
		if cookie != "" {
			request.Header.Set("Cookie", cookie)
		}
		for i := 0; i+1 < len(headers); i += 2 {
			request.Header.Set(headers[i], headers[i+1])
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	signIn := do("POST", "/tenant/auth/sign-in", `{"email":"admin@example.test","password":"bench-fixture"}`, "")
	cookie := strings.SplitN(signIn.Header().Get("Set-Cookie"), ";", 2)[0]
	if signIn.Code != 200 || cookie == "" {
		t.Fatalf("sign-in %d", signIn.Code)
	}

	created := do("POST", "/tenant/bench/_preview/items", `{"id":"p1","name":"Preview"}`, cookie, "Prefer", "tx=rollback")
	var envelope map[string]any
	_ = json.Unmarshal(created.Body.Bytes(), &envelope)
	if created.Code != 200 || envelope["status"] != float64(201) || len(envelope["changes"].([]any)) != 1 {
		t.Fatalf("preview %d %s", created.Code, created.Body)
	}
	if read := do("GET", "/tenant/items/p1", "", cookie); read.Code != 404 {
		t.Fatalf("the preview persisted: %d", read.Code)
	}
	if anonymous := do("POST", "/tenant/bench/_preview/items", `{}`, "", "Prefer", "tx=rollback"); anonymous.Code != 401 {
		t.Errorf("anonymous preview = %d", anonymous.Code)
	}
	if unmarked := do("POST", "/tenant/bench/_preview/items/p1/ordinary", ``, cookie, "Prefer", "tx=rollback"); unmarked.Code != 409 {
		t.Errorf("unmarked preview = %d", unmarked.Code)
	}
	boom := do("POST", "/tenant/bench/_preview/items/p2/fail?mode=exception", ``, cookie, "Prefer", "tx=rollback")
	if boom.Code != 500 || strings.Contains(boom.Body.String(), "rolledBack") {
		t.Errorf("a panicking handler = %d %s", boom.Code, boom.Body)
	}
	if read := do("GET", "/tenant/items/p2", "", cookie); read.Code != 404 {
		t.Errorf("the failed preview persisted: %d", read.Code)
	}
	if sent := do("POST", "/tenant/items", `{"id":"s1","name":"Sent"}`, cookie); sent.Code != 201 {
		t.Fatalf("send %d", sent.Code)
	}
	if read := do("GET", "/tenant/items/s1", "", cookie); read.Code != http.StatusOK {
		t.Errorf("Send did not persist: %d", read.Code)
	}
}
