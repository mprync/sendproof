package mongobench_test

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/mprync/sendproof/adapters/go/mongobench"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

func TestHeldMongoBeforeImages(t *testing.T) {
	a := newApp(t, appOptions{monitor: true})
	t.Cleanup(a.bench.Close)
	path := "/sendproof/_api/sessions"
	open := a.do("POST", path, "", nil)
	var result struct{ ID string }
	if json.Unmarshal(open.Body.Bytes(), &result) != nil || open.Code != 201 || result.ID == "" {
		t.Fatalf("open = %d %s", open.Code, open.Body)
	}
	headers := map[string]string{"Prefer": "tx=rollback", "Sendproof-Session": result.ID}
	step := func(method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		response := a.do(method, "/sendproof/_preview/documents"+path, body, headers)
		if response.Code != 200 {
			t.Fatalf("preview %s %s = %d %s", method, path, response.Code, response.Body)
		}
		return response
	}
	step("POST", "", `{"id":"held","name":"Initial","password":"secret"}`)
	change := step("PATCH", "/held", `{"name":"Changed"}`)
	for _, want := range []string{`"operation":"update"`, `"name":"Initial"`, `"name":"Changed"`, `"[REDACTED]"`} {
		if !strings.Contains(change.Body.String(), want) {
			t.Fatalf("update missing %s: %s", want, change.Body)
		}
	}
	if strings.Contains(change.Body.String(), "hashed:secret") {
		t.Fatalf("secret leaked: %s", change.Body)
	}
	rewind := a.do("POST", path+"/"+result.ID+"/rewind", `{"step":2}`, nil)
	if rewind.Code != 204 {
		t.Fatalf("rewind = %d %s", rewind.Code, rewind.Body)
	}
	if read := step("GET", "/held", ""); !strings.Contains(read.Body.String(), `"name":"Initial"`) ||
		!strings.Contains(read.Body.String(), `"step":2`) {
		t.Fatalf("rewind did not restore the earlier version: %s", read.Body)
	}
	end := a.do("DELETE", path+"/"+result.ID, "", nil)
	if end.Code != 204 {
		t.Fatalf("end = %d %s", end.Code, end.Body)
	}
	if err := a.plain.FindOne(context.Background(), bson.M{"_id": "held"}).Err(); err != mongo.ErrNoDocuments {
		t.Fatalf("held write became visible: %v", err)
	}
}

func TestHeldMongoExpiredTransaction(t *testing.T) {
	a := newApp(t, appOptions{monitor: true, store: []mongobench.Option{mongobench.WithPreviewTimeout(time.Millisecond)}})
	t.Cleanup(a.bench.Close)
	open := a.do("POST", "/sendproof/_api/sessions", "", nil)
	var result struct{ ID string }
	if json.Unmarshal(open.Body.Bytes(), &result) != nil || open.Code != 201 || result.ID == "" {
		t.Fatalf("open = %d %s", open.Code, open.Body)
	}
	time.Sleep(25 * time.Millisecond)
	response := a.do("GET", "/sendproof/_preview/documents/seeded", "", map[string]string{
		"Prefer": "tx=rollback", "Sendproof-Session": result.ID,
	})
	if response.Code != 409 || !strings.Contains(response.Body.String(), `"code":"session_failed"`) {
		t.Fatalf("expired session = %d %s", response.Code, response.Body)
	}
}
