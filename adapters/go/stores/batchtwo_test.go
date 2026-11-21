package stores

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

// batchTwoCases are the batch-two vectors of classification-cases.json. Each
// store's cases have their own shapes; see the file's $comment.
type batchTwoCases struct {
	Cassandra []struct {
		Statement string `json:"statement"`
		Message   string `json:"message"`
		Prepared  string `json:"prepared"`
		Expect    string `json:"expect"`
		Operation string `json:"operation"`
	} `json:"cassandra"`
	Elasticsearch []struct {
		Method    string          `json:"method"`
		Path      string          `json:"path"`
		Body      json.RawMessage `json:"body"`
		Expect    string          `json:"expect"`
		Operation string          `json:"operation"`
	} `json:"elasticsearch"`
	CosmosDB []struct {
		OperationType string `json:"operationType"`
		Triggers      bool   `json:"triggers"`
		Request       *struct {
			Method  string            `json:"method"`
			Path    string            `json:"path"`
			Headers map[string]string `json:"headers"`
		} `json:"request"`
		Expect    string `json:"expect"`
		Operation string `json:"operation"`
	} `json:"cosmosdb"`
	Firestore []struct {
		RPC     string          `json:"rpc"`
		Message json.RawMessage `json:"message"`
		REST    *struct {
			Method string          `json:"method"`
			Path   string          `json:"path"`
			Body   json.RawMessage `json:"body"`
		} `json:"rest"`
		Expect    string `json:"expect"`
		Operation string `json:"operation"`
	} `json:"firestore"`
}

// searchBody turns a vector's body into the bytes a client would send: a string is
// raw text, an array is newline-delimited JSON, anything else is one JSON document.
func searchBody(t *testing.T, raw json.RawMessage) []byte {
	t.Helper()
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil
	}
	switch trimmed[0] {
	case '"':
		var text string
		if err := json.Unmarshal(trimmed, &text); err != nil {
			t.Fatal(err)
		}
		return []byte(text)
	case '[':
		var lines []json.RawMessage
		if err := json.Unmarshal(trimmed, &lines); err != nil {
			t.Fatal(err)
		}
		var out bytes.Buffer
		for _, line := range lines {
			out.Write(line)
			out.WriteByte('\n')
		}
		return out.Bytes()
	}
	return trimmed
}

// writesOf counts the writes of a Firestore Commit message, or -1 when the case
// has no message (a hook that cannot read it).
func writesOf(t *testing.T, raw json.RawMessage) int {
	t.Helper()
	if len(bytes.TrimSpace(raw)) == 0 {
		return -1
	}
	var message struct {
		Writes []json.RawMessage `json:"writes"`
	}
	if err := json.Unmarshal(raw, &message); err != nil {
		t.Fatal(err)
	}
	return len(message.Writes)
}

func check(t *testing.T, label string, got Decision, expect, operation string) {
	t.Helper()
	if got.Kind.String() != expect || got.Operation != operation {
		t.Errorf("%s: got %s %q, want %s %q", label, got.Kind, got.Operation, expect, operation)
	}
}

// TestBatchTwoClassifiersPassSharedVectors runs every batch-two case in classification-cases.json.
func TestBatchTwoClassifiersPassSharedVectors(t *testing.T) {
	var cases batchTwoCases
	if err := json.Unmarshal(readSpec(t, "classification-cases.json"), &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases.Cassandra) == 0 || len(cases.Elasticsearch) == 0 || len(cases.CosmosDB) == 0 || len(cases.Firestore) == 0 {
		t.Fatal("the batch-two vectors are empty")
	}
	for _, c := range cases.Cassandra {
		switch {
		case c.Message == "":
			check(t, "cassandra "+c.Statement, ClassifyCQL(c.Statement), c.Expect, c.Operation)
		case c.Message == "QUERY":
			check(t, "cassandra QUERY", ClassifyCQLMessage("QUERY", c.Statement), c.Expect, c.Operation)
		default:
			text := c.Statement
			if c.Message == "EXECUTE" {
				text = c.Prepared
			}
			check(t, "cassandra "+c.Message, ClassifyCQLMessage(c.Message, text), c.Expect, c.Operation)
		}
	}
	for _, c := range cases.Elasticsearch {
		got := ClassifySearch(SearchRequest{Method: c.Method, Target: c.Path, Body: searchBody(t, c.Body)})
		check(t, "search "+c.Method+" "+c.Path, got, c.Expect, c.Operation)
	}
	for _, c := range cases.CosmosDB {
		if c.Request == nil {
			check(t, "cosmos "+c.OperationType, ClassifyCosmosOperation(c.OperationType, c.Triggers), c.Expect, c.Operation)
			continue
		}
		headers := func(name string) string {
			for key, value := range c.Request.Headers {
				if strings.EqualFold(key, name) {
					return value
				}
			}
			return ""
		}
		check(t, "cosmos "+c.Request.Method+" "+c.Request.Path, DeriveCosmosOperation(c.Request.Method, c.Request.Path, headers), c.Expect, c.Operation)
	}
	for _, c := range cases.Firestore {
		if c.REST != nil {
			check(t, "firestore "+c.REST.Method+" "+c.REST.Path, ClassifyFirestoreREST(c.REST.Method, c.REST.Path, writesOf(t, c.REST.Body)), c.Expect, c.Operation)
			continue
		}
		check(t, "firestore "+c.RPC, ClassifyFirestoreRPC(c.RPC, writesOf(t, c.Message)), c.Expect, c.Operation)
	}
}

func TestSanitizeLiteralsKeepsNamesNotValues(t *testing.T) {
	cases := []struct {
		input   string
		double  bool
		want    string
		comment string
	}{
		{"INSERT INTO tickets (id, status, hits) VALUES (?, 'new', 1)", false, "INSERT INTO tickets (id, status, hits) VALUES (?, ?, ?)", "strings and numbers"},
		{`SELECT "Col2" FROM "Ks".t WHERE a = 'it''s' AND b = $$x;y$$`, false, `SELECT "Col2" FROM "Ks".t WHERE a = ? AND b = ?`, "quoted names kept"},
		{"SELECT * FROM t WHERE id = 550e8400-e29b-41d4-a716-446655440000 AND n = 0xCAFE AND f = 1.5e-3", false, "SELECT * FROM t WHERE id = ? AND n = ? AND f = ?", "uuid, hex, float"},
		{"SELECT a /* secret 42 */ FROM t -- 'x'\n WHERE b = 2", false, "SELECT a   FROM t   WHERE b = ?", "comments dropped"},
		{`SELECT * FROM c WHERE c.status = "open" AND c["n"] = 7`, true, "SELECT * FROM c WHERE c.status = ? AND c[?] = ?", "cosmos double quotes"},
		{"SELECT col2 FROM t_1", false, "SELECT col2 FROM t_1", "digits inside names"},
	}
	for _, c := range cases {
		if got := SanitizeLiterals(c.input, c.double); got != c.want {
			t.Errorf("%s: SanitizeLiterals(%q) = %q, want %q", c.comment, c.input, got, c.want)
		}
	}
}

func TestCQLTarget(t *testing.T) {
	cases := map[string][2]string{
		"SELECT * FROM inventory.tickets WHERE id = ?": {"inventory", "tickets"},
		"INSERT INTO tickets (id) VALUES ('a')":        {"", "tickets"},
		`UPDATE "Ks"."Tickets" SET a = 1 WHERE id = ?`: {"Ks", "Tickets"},
		"TRUNCATE TABLE tickets":                       {"", "tickets"},
		"DELETE FROM tickets WHERE id = ?":             {"", "tickets"},
		"USE inventory":                                {"", ""},
	}
	for text, want := range cases {
		if keyspace, table := CQLTarget(text); keyspace != want[0] || table != want[1] {
			t.Errorf("CQLTarget(%q) = %q, %q, want %q, %q", text, keyspace, table, want[0], want[1])
		}
	}
}

func TestSanitizeJSONKeepsFieldNames(t *testing.T) {
	cases := map[string]string{
		`{"query":{"term":{"title":"secret"}},"size":1}`:                  `{"query":{"term":{"title":"?"}},"size":"?"}`,
		"{\"index\":{\"_id\":\"1\"}}\n{\"title\":\"x\",\"tags\":[1,2]}\n": "{\"index\":{\"_id\":\"?\"}}\n{\"title\":\"?\",\"tags\":[\"?\",\"?\"]}",
		"":         "",
		"not json": `"?"`,
	}
	for input, want := range cases {
		if got := SanitizeJSON([]byte(input)); got != want {
			t.Errorf("SanitizeJSON(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestSearchTargetNeverNamesIds(t *testing.T) {
	cases := map[string]string{"/articles/_doc/42": "articles", "/_search": "", "/logs-*,metrics/_search?x=1": "logs-*,metrics", "/": ""}
	for path, want := range cases {
		if got := SearchTarget(path); got != want {
			t.Errorf("SearchTarget(%q) = %q, want %q", path, got, want)
		}
	}
}

// TestCQLSecondStatementIsAWrite covers the scanner's edge cases beyond the shared vectors.
func TestCQLScannerEdges(t *testing.T) {
	cases := []struct {
		text string
		kind Kind
		op   string
	}{
		{"SELECT 1 FROM t;;", Read, "SELECT"},
		{"SELECT 1 FROM t; -- done\n/* x */ ", Read, "SELECT"},
		{"SELECT 1 FROM t; /* x */ UPDATE t SET a = 1", Write, "SELECT"},
		{"SELECT 'a\\'; DELETE FROM t; --'", Write, "SELECT"},
		{"LIST SOMETHING", Write, "LIST"},
		{"LIST ROLES;", Read, "LIST ROLES"},
		{"select\n*\nfrom t", Read, "SELECT"},
		{"(SELECT 1)", Write, "UNKNOWN"},
		{"USE ks; USE other", Write, "USE"},
	}
	for _, c := range cases {
		got := ClassifyCQL(c.text)
		if got.Kind != c.kind || got.Operation != c.op {
			t.Errorf("ClassifyCQL(%q) = %s %q, want %s %q", c.text, got.Kind, got.Operation, c.kind, c.op)
		}
	}
}
