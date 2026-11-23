package tests

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mprync/sendproof/adapters/go/examples/fixture"
)

func TestFailedPreviewStepAndUnsafeTransaction(t *testing.T) {
	handler, cleanup, err := fixture.New(fixture.Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(cleanup)
	cookie := signIn(t, handler, "")
	var id string
	request := func(method, path, body string, status int) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Cookie", cookie)
		if strings.HasPrefix(path, "/sendproof/_preview") {
			req.Header.Set("Sendproof-Session", id)
			req.Header.Set("Prefer", "tx=rollback")
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		if response.Code != status || (status >= 400 && response.Header().Get("Preference-Applied") != "") {
			t.Fatalf("%s %s = %d %s", method, path, response.Code, response.Body)
		}
		return response
	}
	opened := request("POST", "/sendproof/_api/sessions", "", 201)
	var session struct{ ID string }
	if err := json.Unmarshal(opened.Body.Bytes(), &session); err != nil || session.ID == "" {
		t.Fatalf("open: %s", opened.Body)
	}
	id = session.ID
	request("POST", "/sendproof/_preview/items", `{"id":"kept","name":"First"}`, 200)
	request("POST", "/sendproof/_preview/items/discarded/fail?mode=exception", "", 500)
	read := request("GET", "/sendproof/_preview/items/discarded", "", 200)
	if !strings.Contains(read.Body.String(), `"status":404`) || !strings.Contains(read.Body.String(), `"step":2`) {
		t.Fatalf("failed step consumed a step or kept its row: %s", read.Body)
	}
	read = request("GET", "/sendproof/_preview/items/kept", "", 200)
	if !strings.Contains(read.Body.String(), `"name":"First"`) {
		t.Fatalf("failed step undid an earlier write: %s", read.Body)
	}
	request("POST", "/sendproof/_preview/items/unsafe/commit", `{"name":"Unsafe"}`, 500)
	request("DELETE", "/sendproof/_api/sessions/"+id, "", 404)
	request("GET", "/items/kept", "", 404)
	request("GET", "/items/unsafe", "", 404)
}
