package stores

import (
	"bytes"
	"encoding/json"
	"net/url"
	"strings"
)

// This file is the batch-two half of the classification: Cassandra (CQL),
// Elasticsearch and OpenSearch (HTTP), Cosmos DB (operation type or HTTP request)
// and Firestore (RPC or REST). Each classifier is pure and returns a Decision;
// everything its table does not list is a write.

// Decision is the classification of one batch-two request.
type Decision struct {
	// Kind is Read, Write or Session.
	Kind Kind
	// Operation is the db.operation.name the Db entry and the 409 body use.
	Operation string
}

// ---- Cassandra ----

// ClassifyCQL classifies CQL statement text. A text is a read only when it holds
// one statement whose first keyword the table lists; a second statement, an
// unterminated quote or comment, no statement at all, a BATCH and everything
// unlisted is a write. USE only changes the connection's keyspace, so it is read.
func ClassifyCQL(text string) Decision {
	scan := scanText(text, cqlSyntax)
	if !scan.wellFormed || len(scan.words) == 0 || scan.words[0] == "" {
		return Decision{Kind: Write, Operation: "UNKNOWN"}
	}
	first := scan.words[0]
	if first == "BEGIN" {
		return Decision{Kind: Write, Operation: "BATCH"}
	}
	key := first
	if first == "LIST" && len(scan.words) > 1 {
		key = "LIST " + scan.words[1]
	}
	if cassandraTable.read[key] {
		if scan.extra {
			return Decision{Kind: Write, Operation: key}
		}
		return Decision{Kind: Read, Operation: key}
	}
	return Decision{Kind: Write, Operation: first}
}

// ClassifyCQLMessage classifies a native-protocol message. text is the statement
// of a QUERY or PREPARE, or the text an EXECUTE's id was prepared from ("" when
// the hook never saw it prepared). STARTUP, OPTIONS, REGISTER, AUTH_RESPONSE and
// PREPARE carry no data change; BATCH and every other message are writes.
func ClassifyCQLMessage(message, text string) Decision {
	name := strings.ToUpper(message)
	switch {
	case cassandraTable.session[name]:
		return Decision{Kind: Session, Operation: name}
	case name == "QUERY":
		return ClassifyCQL(text)
	case name == "EXECUTE":
		if strings.TrimSpace(text) == "" {
			return Decision{Kind: Write, Operation: "EXECUTE"}
		}
		return ClassifyCQL(text)
	}
	return Decision{Kind: Write, Operation: name}
}

// CQLTarget returns the keyspace and table a CQL statement names, as written
// without quotes ("" when it names none or the text is not recognised). It is for
// the Db entry only, never for a decision.
func CQLTarget(text string) (keyspace, table string) {
	words := cqlWords(text)
	for index := 0; index < len(words); index++ {
		switch strings.ToUpper(words[index]) {
		case "FROM", "INTO", "UPDATE", "TRUNCATE":
			next := index + 1
			if next < len(words) && strings.EqualFold(words[next], "TABLE") {
				next++
			}
			if next >= len(words) {
				return "", ""
			}
			name := words[next]
			if cut := strings.IndexByte(name, '.'); cut >= 0 {
				return unquoteIdentifier(name[:cut]), unquoteIdentifier(name[cut+1:])
			}
			return "", unquoteIdentifier(name)
		}
	}
	return "", ""
}

func unquoteIdentifier(name string) string {
	return strings.Trim(name, `"`)
}

// cqlWords splits text into whitespace-separated words with comments removed and
// parentheses and commas split off; enough to find the table name.
func cqlWords(text string) []string {
	clean := SanitizeLiterals(text, false)
	clean = strings.NewReplacer("(", " ", ")", " ", ",", " ", ";", " ").Replace(clean)
	return strings.Fields(clean)
}

// ---- Elasticsearch and OpenSearch ----

// searchKind values of an endpoint entry: the table also uses "sql".
const searchSQL = "sql"

// SearchRequest is one HTTP request an Elasticsearch or OpenSearch client sends.
type SearchRequest struct {
	// Method is the HTTP method.
	Method string
	// Target is the request path, with or without its query string. Remove any
	// configured path prefix first.
	Target string
	// Body is the request body, or nil. Only the SQL endpoints read it to decide.
	Body []byte
}

// ClassifySearch classifies an Elasticsearch or OpenSearch request: the first
// table entry whose method and path match decides; otherwise GET and HEAD read and
// everything else writes. The SQL endpoints read only for one SELECT, SHOW or
// DESCRIBE statement, or the next page of a cursor.
func ClassifySearch(request SearchRequest) Decision {
	method := strings.ToUpper(request.Method)
	segments := searchSegments(request.Target)
	for _, entry := range searchTable.endpoints {
		if !entry.matches(method, segments) {
			continue
		}
		switch entry.Kind {
		case "read":
			return Decision{Kind: Read, Operation: entry.Name}
		case "session":
			return Decision{Kind: Session, Operation: entry.Name}
		case searchSQL:
			if searchSQLIsRead(request.Body) {
				return Decision{Kind: Read, Operation: entry.Name}
			}
			return Decision{Kind: Write, Operation: entry.Name}
		}
		return Decision{Kind: Write, Operation: entry.Name}
	}
	kind := Write
	if method == "GET" || method == "HEAD" {
		kind = Read
	}
	return Decision{Kind: kind, Operation: searchOperationName(method, segments)}
}

// searchSegments splits a request target into percent-decoded path segments,
// dropping the query string, repeated slashes and a trailing slash.
func searchSegments(target string) []string {
	path := target
	if cut := strings.IndexAny(path, "?#"); cut >= 0 {
		path = path[:cut]
	}
	var segments []string
	for _, raw := range strings.Split(path, "/") {
		if raw == "" {
			continue
		}
		segment, err := url.PathUnescape(raw)
		if err != nil {
			segment = raw
		}
		segments = append(segments, segment)
	}
	return segments
}

// searchOperationName is the name of a request no entry matched: the method and
// the path with every segment that does not start with an underscore replaced by {}.
func searchOperationName(method string, segments []string) string {
	parts := make([]string, len(segments))
	for index, segment := range segments {
		if strings.HasPrefix(segment, "_") {
			parts[index] = segment
		} else {
			parts[index] = "{}"
		}
	}
	return method + " /" + strings.Join(parts, "/")
}

// matches reports whether the entry's method and one of its paths match.
func (e searchEndpoint) matches(method string, segments []string) bool {
	found := false
	for _, allowed := range e.Methods {
		if allowed == method {
			found = true
		}
	}
	if !found {
		return false
	}
	for _, path := range e.paths {
		if len(path) != len(segments) {
			continue
		}
		matched := true
		for index, want := range path {
			segment := segments[index]
			switch want {
			case "{index}":
				matched = segment != "" && !strings.HasPrefix(segment, "_")
			case "{id}":
				matched = segment != ""
			default:
				matched = segment == want
			}
			if !matched {
				break
			}
		}
		if matched {
			return true
		}
	}
	return false
}

// searchSQLIsRead applies the table's SQL rule to a request body.
func searchSQLIsRead(body []byte) bool {
	var request struct {
		Query  *string `json:"query"`
		Cursor *string `json:"cursor"`
	}
	if err := json.Unmarshal(body, &request); err != nil {
		return false
	}
	if request.Query == nil {
		return request.Cursor != nil
	}
	scan := scanText(*request.Query, sqlSyntax)
	if !scan.wellFormed || scan.extra || len(scan.words) == 0 {
		return false
	}
	return searchTable.sqlReadWords[scan.words[0]]
}

// SearchTarget returns the index a request path names, "" when it names none
// (document ids and other path parts are never returned). It is for the Db entry
// only.
func SearchTarget(target string) string {
	segments := searchSegments(target)
	if len(segments) == 0 || strings.HasPrefix(segments[0], "_") {
		return ""
	}
	return segments[0]
}

// SanitizeJSON renders a JSON request body as text with every literal replaced by
// "?", keeping field names, as SanitizeDocument does for MongoDB. Newline-delimited
// JSON (_bulk, _msearch) yields one line per document. Text that is not JSON
// yields "?".
func SanitizeJSON(body []byte) string {
	text := bytes.TrimSpace(body)
	if len(text) == 0 {
		return ""
	}
	decoder := json.NewDecoder(bytes.NewReader(text))
	var lines []string
	for decoder.More() {
		value, err := decodeOrdered(decoder)
		if err != nil {
			return `"?"`
		}
		lines = append(lines, SanitizeDocument(value))
	}
	if len(lines) == 0 {
		return `"?"`
	}
	return strings.Join(lines, "\n")
}

// decodeOrdered decodes one JSON value into the ordered Doc form.
func decodeOrdered(decoder *json.Decoder) (any, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	delim, ok := token.(json.Delim)
	if !ok {
		return token, nil
	}
	if delim == '{' {
		doc := Doc{}
		for decoder.More() {
			key, err := decoder.Token()
			if err != nil {
				return nil, err
			}
			value, err := decodeOrdered(decoder)
			if err != nil {
				return nil, err
			}
			doc = append(doc, Field{Key: key.(string), Value: value})
		}
		_, err := decoder.Token()
		return doc, err
	}
	list := []any{}
	for decoder.More() {
		value, err := decodeOrdered(decoder)
		if err != nil {
			return nil, err
		}
		list = append(list, value)
	}
	_, err = decoder.Token()
	return list, err
}

// ---- Cosmos DB ----

// canonicalCosmosOperations maps a lower-case operation type to the spelling the
// table reports.
func canonicalCosmosOperation(name string) string {
	if canonical, ok := cosmosTable.spelling[strings.ToLower(name)]; ok {
		return canonical
	}
	return name
}

// ClassifyCosmosOperation classifies an SDK operation type, compared
// case-insensitively. triggers is true when the request names a pre-trigger or
// post-trigger, which makes any operation a write. An unknown type is a write.
func ClassifyCosmosOperation(operationType string, triggers bool) Decision {
	operation := canonicalCosmosOperation(operationType)
	if !triggers && cosmosTable.read[strings.ToLower(operation)] {
		return Decision{Kind: Read, Operation: operation}
	}
	return Decision{Kind: Write, Operation: operation}
}

// CosmosHeaders reads a request header by name, case-insensitively; "" when absent.
type CosmosHeaders func(name string) string

func headerIsTrue(headers CosmosHeaders, name string) bool {
	return strings.EqualFold(strings.TrimSpace(headers(name)), "true")
}

// DeriveCosmosOperation derives the operation type of an HTTP request with the
// table's fromRequest rules, then classifies it. A request that names a trigger is
// a write whatever it is.
func DeriveCosmosOperation(method, path string, headers CosmosHeaders) Decision {
	triggers := headers("x-ms-documentdb-pre-trigger-include") != "" || headers("x-ms-documentdb-post-trigger-include") != ""
	var segments []string
	for _, segment := range strings.Split(path, "/") {
		if segment != "" {
			segments = append(segments, segment)
		}
	}
	oneResource := len(segments)%2 == 0 && len(segments) > 0
	var operation string
	switch strings.ToUpper(method) {
	case "GET":
		operation = "ReadFeed"
		if oneResource {
			operation = "Read"
		}
	case "HEAD":
		operation = "HeadFeed"
		if oneResource {
			operation = "Head"
		}
	case "POST":
		switch {
		case headerIsTrue(headers, "x-ms-cosmos-is-query-plan-request"):
			operation = "QueryPlan"
		case headerIsTrue(headers, "x-ms-documentdb-isquery") || strings.HasPrefix(strings.ToLower(headers("content-type")), "application/query+json"):
			operation = "Query"
		case headerIsTrue(headers, "x-ms-cosmos-is-batch-request"):
			operation = "Batch"
		case len(segments) == 6 && segments[0] == "dbs" && segments[2] == "colls" && segments[4] == "sprocs":
			operation = "ExecuteJavaScript"
		case headerIsTrue(headers, "x-ms-documentdb-is-upsert"):
			operation = "Upsert"
		default:
			operation = "Create"
		}
	case "PUT":
		operation = "Replace"
	case "PATCH":
		operation = "Patch"
	case "DELETE":
		operation = "Delete"
	default:
		operation = strings.ToUpper(method)
	}
	return ClassifyCosmosOperation(operation, triggers)
}

// CosmosTarget returns the database and container a Cosmos DB path names.
func CosmosTarget(path string) (database, container string) {
	segments := strings.Split(strings.Trim(path, "/"), "/")
	for index := 0; index+1 < len(segments); index += 2 {
		switch segments[index] {
		case "dbs":
			database = segments[index+1]
		case "colls":
			container = segments[index+1]
		}
	}
	return database, container
}

// ---- Firestore ----

const firestoreService = "google.firestore.v1.Firestore"
const firestoreAdminService = "google.firestore.admin.v1.FirestoreAdmin"

// ClassifyFirestoreRPC classifies a gRPC method, given as the full method of an
// interceptor ("/google.firestore.v1.Firestore/Commit") or as a bare method name
// of the Firestore service. commitWrites is the number of writes in a Commit
// request, or -1 when the hook cannot read the message: then every Commit is a
// write. A method of any other service or API version is a write unless it is an
// admin Get or List.
func ClassifyFirestoreRPC(fullMethod string, commitWrites int) Decision {
	service, method := firestoreService, fullMethod
	if trimmed := strings.TrimPrefix(fullMethod, "/"); strings.Contains(trimmed, "/") {
		service, method, _ = strings.Cut(trimmed, "/")
	}
	switch service {
	case firestoreService:
		switch {
		case firestoreTable.read[method]:
			return Decision{Kind: Read, Operation: method}
		case firestoreTable.session[method]:
			return Decision{Kind: Session, Operation: method}
		case method == "Commit" && commitWrites == 0:
			return Decision{Kind: Session, Operation: method}
		}
	case firestoreAdminService:
		for _, prefix := range firestoreTable.adminReadPrefixes {
			if strings.HasPrefix(method, prefix) {
				return Decision{Kind: Read, Operation: method}
			}
		}
	}
	return Decision{Kind: Write, Operation: method}
}

// ClassifyFirestoreREST classifies a request on the REST transport with the
// table's fromRest rules. commitWrites is as for ClassifyFirestoreRPC.
func ClassifyFirestoreREST(method, path string, commitWrites int) Decision {
	if cut := strings.IndexAny(path, "?#"); cut >= 0 {
		path = path[:cut]
	}
	segments := strings.Split(strings.Trim(path, "/"), "/")
	last := segments[len(segments)-1]
	if cut := strings.LastIndexByte(last, ':'); cut >= 0 {
		verb := last[cut+1:]
		if rpc, ok := firestoreTable.restVerbs[verb]; ok {
			return ClassifyFirestoreRPC(rpc, commitWrites)
		}
		return Decision{Kind: Write, Operation: verb}
	}
	after := 0
	for index, segment := range segments {
		if segment == "documents" {
			after = len(segments) - index - 1
			break
		}
	}
	switch strings.ToUpper(method) {
	case "GET":
		if after%2 == 0 {
			return ClassifyFirestoreRPC("GetDocument", commitWrites)
		}
		return ClassifyFirestoreRPC("ListDocuments", commitWrites)
	case "PATCH":
		return Decision{Kind: Write, Operation: "UpdateDocument"}
	case "DELETE":
		return Decision{Kind: Write, Operation: "DeleteDocument"}
	case "POST":
		if after%2 == 1 {
			return Decision{Kind: Write, Operation: "CreateDocument"}
		}
	}
	return Decision{Kind: Write, Operation: strings.ToUpper(method)}
}
