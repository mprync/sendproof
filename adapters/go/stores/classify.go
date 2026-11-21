// Package stores holds what every Sendproof data-store hook shares: the write
// classification of Redis commands, MongoDB command documents and DynamoDB
// actions, driven by the tables embedded from spec/data-stores/, and the helpers
// that turn a command into a log statement without its values.
//
// Each table lists reads and connection-level commands. Everything else,
// including a command the table has never heard of, is a write, so a guard built
// on it fails closed when a store version adds a command. Every function here is
// pure: the guard itself lives in the sendproof package.
package stores

import (
	"fmt"
	"strings"
)

// Kind says how the guard treats one store command. Only Write can block a Preview.
type Kind int

const (
	// Write is anything the tables do not list, and every command that changes data.
	Write Kind = iota
	// Read runs normally in a Preview.
	Read
	// Session is a connection-level command (AUTH, HELLO, PING, SELECT): allowed and never logged.
	Session
	// Transaction is a Redis MULTI, EXEC, DISCARD, WATCH or UNWATCH: allowed, and each
	// queued command is classified on its own.
	Transaction
)

// String returns the lower-case kind name used in the shared vectors.
func (k Kind) String() string {
	return [...]string{"write", "read", "session", "transaction"}[k]
}

// ClassifyRedis classifies a Redis command. name is the command in any case and
// args its arguments, of which only the first is read, to form CONTAINER|SUBCOMMAND
// keys such as OBJECT|ENCODING. treatAsRead holds host-declared reads, compared
// exactly against the upper-case key (see ReadSet).
func ClassifyRedis(name string, args []string, treatAsRead map[string]bool) Kind {
	command := strings.ToUpper(name)
	keys := []string{command}
	if len(args) > 0 {
		keys = []string{command + "|" + strings.ToUpper(args[0]), command}
	}
	for _, key := range keys {
		switch {
		case redisTable.session[key]:
			return Session
		case redisTable.transaction[key]:
			return Transaction
		case redisTable.read[key] || treatAsRead[key]:
			return Read
		}
	}
	return Write
}

// Field is one member of an ordered document.
type Field struct {
	Key   string
	Value any
}

// Doc is an ordered document: a MongoDB command's first key names the command, so
// order matters. Nested documents are Doc, arrays are []any, and every other
// value is a literal.
type Doc []Field

// Get returns the value of the first member with the given name.
func (d Doc) Get(key string) (any, bool) {
	for _, field := range d {
		if field.Key == key {
			return field.Value, true
		}
	}
	return nil, false
}

// MongoClassification is the result of classifying a MongoDB command document.
type MongoClassification struct {
	// Kind is Read, Write or Session.
	Kind Kind
	// Refused names the command or aggregation stage MongoDB refuses inside a
	// transaction, such as "$out"; empty when there is none.
	Refused string
}

// writingStages are the aggregation stages that write.
var writingStages = map[string]bool{"$out": true, "$merge": true}

// pipelineUses reports whether any key, at any depth of an aggregation pipeline
// (sub-pipelines of $facet, $lookup and $unionWith included), is in stages.
func pipelineUses(value any, stages map[string]bool) bool {
	switch typed := value.(type) {
	case Doc:
		for _, field := range typed {
			if stages[field.Key] || pipelineUses(field.Value, stages) {
				return true
			}
		}
	case []any:
		for _, item := range typed {
			if pipelineUses(item, stages) {
				return true
			}
		}
	}
	return false
}

// ClassifyMongo classifies a MongoDB command document by its first key,
// case-insensitively. aggregate is a write when any stage at any depth is $out or
// $merge; explain takes the classification of the command inside it. Refused names
// what a preview-mode Preview must block before sending. treatAsRead holds
// host-declared reads in lower case (see ReadSet).
func ClassifyMongo(command Doc, treatAsRead map[string]bool) MongoClassification {
	if len(command) == 0 {
		return MongoClassification{Kind: Write}
	}
	name := command[0].Key
	lower := strings.ToLower(name)
	if inner, ok := command[0].Value.(Doc); ok && lower == "explain" {
		return ClassifyMongo(inner, treatAsRead)
	}
	refused := ""
	if mongoTable.notInTransaction[lower] {
		refused = name
	}
	pipeline, _ := command.Get("pipeline")
	if lower == "aggregate" {
		for _, stage := range mongoTable.stages {
			if pipelineUses(pipeline, map[string]bool{stage: true}) {
				refused = stage
				break
			}
		}
	}
	switch {
	case mongoTable.session[lower]:
		return MongoClassification{Kind: Session}
	case lower == "aggregate" && pipelineUses(pipeline, writingStages):
		return MongoClassification{Kind: Write, Refused: refused}
	case mongoTable.read[lower] || treatAsRead[lower]:
		return MongoClassification{Kind: Read, Refused: refused}
	}
	return MongoClassification{Kind: Write, Refused: refused}
}

// PartiQLVerb skips whitespace and SQL-style comments, then returns the first word
// of a PartiQL statement in upper case. It returns "" for text it cannot parse.
func PartiQLVerb(statement string) string {
	text := statement
	for {
		trimmed := strings.TrimLeft(text, " \t\r\n\v\f")
		switch {
		case strings.HasPrefix(trimmed, "--"):
			end := strings.IndexByte(trimmed, '\n')
			if end < 0 {
				return ""
			}
			text = trimmed[end+1:]
		case strings.HasPrefix(trimmed, "/*"):
			end := strings.Index(trimmed, "*/")
			if end < 0 {
				return ""
			}
			text = trimmed[end+2:]
		default:
			end := 0
			for end < len(trimmed) && (trimmed[end] >= 'a' && trimmed[end] <= 'z' || trimmed[end] >= 'A' && trimmed[end] <= 'Z') {
				end++
			}
			return strings.ToUpper(trimmed[:end])
		}
	}
}

// IsPartiQL reports whether a DynamoDB action carries PartiQL statements.
func IsPartiQL(operation string) bool { return dynamoTable.partiql[operation] }

// ClassifyDynamo classifies a DynamoDB action. statements are the PartiQL texts of
// an ExecuteStatement, BatchExecuteStatement or ExecuteTransaction request; the
// request is a read only when it has at least one and every one is a SELECT.
// treatAsRead holds host-declared action names, matched exactly.
func ClassifyDynamo(operation string, statements []string, treatAsRead map[string]bool) Kind {
	if dynamoTable.read[operation] || treatAsRead[operation] {
		return Read
	}
	if dynamoTable.partiql[operation] && len(statements) > 0 {
		for _, statement := range statements {
			if PartiQLVerb(statement) != "SELECT" {
				return Write
			}
		}
		return Read
	}
	return Write
}

// ClassifyDynamoInput is ClassifyDynamo for a request given as a generic JSON
// object, as the shared vectors do: Statement, or Statements and TransactStatements
// lists of {Statement}.
func ClassifyDynamoInput(operation string, input map[string]any, treatAsRead map[string]bool) Kind {
	var statements []string
	if statement, ok := input["Statement"].(string); ok && operation == "ExecuteStatement" {
		statements = []string{statement}
	}
	for _, field := range []string{"Statements", "TransactStatements"} {
		list, _ := input[field].([]any)
		for _, item := range list {
			member, _ := item.(map[string]any)
			text, _ := member["Statement"].(string)
			statements = append(statements, text)
		}
	}
	return ClassifyDynamo(operation, statements, treatAsRead)
}

// ReadSet validates host-declared reads ("TreatAsRead"): exact names only, with no
// wildcards or whitespace. transform normalizes each name, for example to upper
// case. It returns nil for an empty list.
func ReadSet(names []string, transform func(string) string) (map[string]bool, error) {
	if len(names) == 0 {
		return nil, nil
	}
	result := make(map[string]bool, len(names))
	for _, name := range names {
		if name == "" || strings.ContainsAny(name, "*? \t\r\n") {
			return nil, fmt.Errorf("stores: TreatAsRead takes exact command names without wildcards, got %q", name)
		}
		if transform != nil {
			name = transform(name)
		}
		result[name] = true
	}
	return result, nil
}

// Label validates the optional label a host gives a store for capabilities
// `dataStores`. Discovery is shown to anyone who can open the workbench, so the
// label must be a display name such as "catalog": never a connection string, URL,
// host:port, user or password.
func Label(name string) (string, error) {
	if name == "" {
		return "", nil
	}
	if strings.TrimSpace(name) == "" || len(name) > 64 || strings.ContainsAny(name, "/\\@=;:?#%") {
		return "", fmt.Errorf("stores: a data store name must be a display label such as \"catalog\", not a connection string, URL or host")
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			return "", fmt.Errorf("stores: a data store name must not contain control characters")
		}
	}
	return name, nil
}
