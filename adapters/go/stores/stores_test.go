package stores

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// specDirectory is where the shared tables and vectors live in the repository.
// Tests that read it skip when the module is built outside the repository.
const specDirectory = "../../../spec/data-stores"

func readSpec(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(specDirectory, name))
	if err != nil {
		t.Skipf("the spec is not available beside this module: %v", err)
	}
	return data
}

// TestEmbeddedTablesMatchSpec fails when a generated copy differs from spec/data-stores/.
func TestEmbeddedTablesMatchSpec(t *testing.T) {
	for _, name := range []string{"redis.json", "mongodb.json", "dynamodb.json"} {
		embedded, err := tableFiles.ReadFile("tables/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(embedded, readSpec(t, name)) {
			t.Errorf("stores/tables/%s differs from spec/data-stores/%s: run `go generate ./stores`", name, name)
		}
	}
}

// orderedDoc decodes JSON into the ordered Doc form, keeping member order.
func orderedDoc(t *testing.T, raw json.RawMessage) Doc {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(raw))
	value := orderedValue(t, decoder)
	doc, ok := value.(Doc)
	if !ok {
		t.Fatalf("expected a document, got %T", value)
	}
	return doc
}

func orderedValue(t *testing.T, decoder *json.Decoder) any {
	t.Helper()
	token, err := decoder.Token()
	if err != nil {
		t.Fatal(err)
	}
	delim, ok := token.(json.Delim)
	if !ok {
		return token
	}
	if delim == '{' {
		doc := Doc{}
		for decoder.More() {
			key, _ := decoder.Token()
			doc = append(doc, Field{Key: key.(string), Value: orderedValue(t, decoder)})
		}
		_, _ = decoder.Token()
		return doc
	}
	list := []any{}
	for decoder.More() {
		list = append(list, orderedValue(t, decoder))
	}
	_, _ = decoder.Token()
	return list
}

type vectors struct {
	Redis []struct {
		Command []string `json:"command"`
		Expect  string   `json:"expect"`
	} `json:"redis"`
	MongoDB []struct {
		Command json.RawMessage `json:"command"`
		Expect  string          `json:"expect"`
		Refused string          `json:"refusedInTransaction"`
	} `json:"mongodb"`
	DynamoDB []struct {
		Operation string         `json:"operation"`
		Input     map[string]any `json:"input"`
		Expect    string         `json:"expect"`
	} `json:"dynamodb"`
}

// TestClassifiersPassSharedVectors runs every case in classification-cases.json.
func TestClassifiersPassSharedVectors(t *testing.T) {
	var cases vectors
	if err := json.Unmarshal(readSpec(t, "classification-cases.json"), &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases.Redis) == 0 || len(cases.MongoDB) == 0 || len(cases.DynamoDB) == 0 {
		t.Fatal("the shared vectors are empty")
	}
	for _, c := range cases.Redis {
		if got := ClassifyRedis(c.Command[0], c.Command[1:], nil).String(); got != c.Expect {
			t.Errorf("redis %v: got %s, want %s", c.Command, got, c.Expect)
		}
	}
	for _, c := range cases.MongoDB {
		got := ClassifyMongo(orderedDoc(t, c.Command), nil)
		if got.Kind.String() != c.Expect || got.Refused != c.Refused {
			t.Errorf("mongodb %s: got %s refused %q, want %s refused %q", c.Command, got.Kind, got.Refused, c.Expect, c.Refused)
		}
	}
	for _, c := range cases.DynamoDB {
		if got := ClassifyDynamoInput(c.Operation, c.Input, nil).String(); got != c.Expect {
			t.Errorf("dynamodb %s %v: got %s, want %s", c.Operation, c.Input, got, c.Expect)
		}
	}
}

func TestHostDeclaredReadsAreExact(t *testing.T) {
	reads, err := ReadSet([]string{"mymodule.get"}, strings.ToUpper)
	if err != nil {
		t.Fatal(err)
	}
	if got := ClassifyRedis("MYMODULE.GET", []string{"k"}, reads); got != Read {
		t.Errorf("declared read: got %s", got)
	}
	if got := ClassifyRedis("MYMODULE.SET", []string{"k"}, reads); got != Write {
		t.Errorf("an undeclared command stays a write: got %s", got)
	}
	for _, bad := range []string{"MY*", "A B", ""} {
		if _, err := ReadSet([]string{bad}, nil); err == nil {
			t.Errorf("%q must be refused: wildcards and spaces are not exact names", bad)
		}
	}
}

func TestSanitizePartiQLReplacesLiterals(t *testing.T) {
	cases := map[string]string{
		`UPDATE "orders" SET status = 'cancelled' WHERE id = ?`:      `UPDATE "orders" SET status = ? WHERE id = ?`,
		`SELECT * FROM "t_1" WHERE n = 42 AND f = 1.5e3`:             `SELECT * FROM "t_1" WHERE n = ? AND f = ?`,
		`INSERT INTO "t" VALUE {'id': 'it''s', 'n': 7}`:              `INSERT INTO "t" VALUE {?: ?, ?: ?}`,
		`SELECT "col2" FROM "my.table2" WHERE x = 'a "quoted" word'`: `SELECT "col2" FROM "my.table2" WHERE x = ?`,
		`SELECT name2 FROM t WHERE a = 'unterminated`:                `SELECT name2 FROM t WHERE a = ?`,
	}
	for input, want := range cases {
		if got := SanitizePartiQL(input); got != want {
			t.Errorf("SanitizePartiQL(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestRedisStatementShowsKeysNotValues(t *testing.T) {
	cases := []struct {
		name, statement, target string
		args                    []string
	}{
		{"set", "SET session:42 ?", "session:42", []string{"session:42", "token-value"}},
		{"incr", "INCR counter:a", "counter:a", []string{"counter:a"}},
		{"mget", "MGET a b", "a", []string{"a", "b"}},
		{"mset", "MSET a ? b ?", "a", []string{"a", "1", "b", "2"}},
		{"publish", "PUBLISH ? ?", "", []string{"channel", "payload"}},
		{"eval", "EVAL ? ? ?", "", []string{"return redis.call('set','k','v')", "1", "k"}},
	}
	for _, c := range cases {
		statement, target := RedisStatement(strings.Fields(c.statement)[0], c.args)
		if statement != c.statement || target != c.target {
			t.Errorf("%s: got %q target %q, want %q target %q", c.name, statement, target, c.statement, c.target)
		}
	}
}

func TestSanitizeDocumentKeepsNamesAndOperators(t *testing.T) {
	doc := Doc{{"update", "documents"}, {"updates", []any{Doc{{"q", Doc{{"_id", "doc-1"}}}, {"u", Doc{{"$set", Doc{{"name", "x"}}}}}}}}}
	want := `{"update":"?","updates":[{"q":{"_id":"?"},"u":{"$set":{"name":"?"}}}]}`
	if got := SanitizeDocument(doc); got != want {
		t.Errorf("got %s, want %s", got, want)
	}
}

func TestLabelRefusesConnectionDetails(t *testing.T) {
	for _, bad := range []string{"mongodb://u:p@h/db", "host:27017", "a/b", "user@host", "x=y", strings.Repeat("a", 65)} {
		if _, err := Label(bad); err == nil {
			t.Errorf("%q must be refused", bad)
		}
	}
	if got, err := Label("catalog"); err != nil || got != "catalog" {
		t.Errorf("catalog: %q %v", got, err)
	}
}
