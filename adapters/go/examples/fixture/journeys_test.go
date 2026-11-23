package fixture

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"testing"
)

func TestCodeJourneyMatchesFixtureFiles(t *testing.T) {
	handler, cleanup, err := New(Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(cleanup)
	get := func(path string) []byte {
		t.Helper()
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusOK {
			t.Fatalf("GET %s returned %d: %s", path, response.Code, response.Body)
		}
		return response.Body.Bytes()
	}
	var caps struct {
		Journeys []struct{ Source, ArazzoURL, ExpectationsURL string }
	}
	if err := json.Unmarshal(get("/sendproof/_api/capabilities"), &caps); err != nil {
		t.Fatal(err)
	}
	if len(caps.Journeys) != 1 || caps.Journeys[0].Source != "code" {
		t.Fatalf("expected one code journey, got %+v", caps.Journeys)
	}
	entry := caps.Journeys[0]
	for file, url := range map[string]string{
		"journeys/items.arazzo.json": entry.ArazzoURL,
		"journeys/items.expect.json": entry.ExpectationsURL,
	} {
		want, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		got := get(url)
		var gotJSON, wantJSON any
		if err := json.Unmarshal(got, &gotJSON); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(want, &wantJSON); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(gotJSON, wantJSON) {
			t.Errorf("%s differs from %s\ngot: %s\nwant: %s", url, file, got, want)
		}
	}
}
