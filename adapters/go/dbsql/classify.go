package dbsql

import (
	"errors"
	"fmt"
	"strings"
)

// ErrUnsafeStatement reports a statement that a preview refuses because it could
// end the preview transaction, and with it the guarantee that nothing is kept.
// Transaction control, statements that commit implicitly and procedure calls that
// may commit are refused; the application's own transactions still work through
// BeginTx, which runs them on savepoints.
var ErrUnsafeStatement = errors.New("dbsql: the statement could end the preview transaction")

// savepointOp is a savepoint statement the capture journal must follow.
type savepointOp struct {
	kind string // "create", "release" or "rollback"
	name string
}

// statementInfo summarizes the statements of one SQL text.
type statementInfo struct {
	tokens     []token
	statements [][]token
	// savepoints lists the savepoint statements in order.
	savepoints []savepointOp
	// mayWrite reports a statement that is not known to be read-only.
	mayWrite bool
	// procedure reports a procedure call, whose writes are opaque to keyed capture.
	procedure bool
	// begins and ends report raw transaction control (outside a preview).
	begins, ends, rollsBack bool
}

func analyze(text string, dialect Dialect) statementInfo {
	return analyzeTokens(lex(text, dialect), dialect)
}

func analyzeTokens(tokens []token, dialect Dialect) statementInfo {
	info := statementInfo{tokens: tokens, statements: splitStatements(tokens)}
	for _, statement := range info.statements {
		words := leadingWords(statement, 4)
		if len(words) == 0 {
			info.mayWrite = true
			continue
		}
		if op, ok := savepointStatement(statement, words, dialect); ok {
			info.savepoints = append(info.savepoints, op)
			continue
		}
		switch words[0] {
		case "SELECT", "VALUES", "SHOW", "EXPLAIN", "DESCRIBE", "DESC", "PRAGMA", "SET", "USE", "DECLARE", "PRINT", "TABLE":
			if words[0] == "SELECT" && selectWrites(statement) {
				info.mayWrite = true
			}
			if words[0] == "PRAGMA" && pragmaWrites(statement) {
				info.mayWrite = true
			}
		case "WITH":
			if containsWord(statement, "INSERT", "UPDATE", "DELETE", "MERGE", "REPLACE") {
				info.mayWrite = true
			}
		case "BEGIN", "START":
			if dialect != DialectSQLServer || len(words) > 1 && (words[1] == "TRAN" || words[1] == "TRANSACTION" || words[1] == "DISTRIBUTED") {
				info.begins = true
			}
		case "COMMIT", "END":
			if words[0] == "COMMIT" || dialect != DialectSQLServer {
				info.ends = true
			}
		case "ROLLBACK", "ABORT":
			info.ends, info.rollsBack = true, true
		case "CALL", "EXEC", "EXECUTE", "DO":
			info.mayWrite, info.procedure = true, true
		default:
			info.mayWrite = true
		}
	}
	return info
}

// selectWrites reports SELECT ... INTO, which creates or fills a table.
func selectWrites(statement []token) bool {
	depth := 0
	for _, tok := range statement {
		switch {
		case tok.is(tokPunct, "("):
			depth++
		case tok.is(tokPunct, ")"):
			depth--
		case depth == 0 && tok.word("INTO"):
			return true
		}
	}
	return false
}

// pragmaWrites reports a PRAGMA that assigns a value rather than reading one.
func pragmaWrites(statement []token) bool {
	for _, tok := range statement {
		if tok.is(tokPunct, "=") {
			return true
		}
	}
	return false
}

func containsWord(statement []token, words ...string) bool {
	for _, tok := range statement {
		if tok.kind != tokWord {
			continue
		}
		for _, word := range words {
			if tok.value == word {
				return true
			}
		}
	}
	return false
}

// savepointStatement recognizes SAVEPOINT, RELEASE and ROLLBACK TO in the
// dialect's syntax, including SQL Server's SAVE TRANSACTION.
func savepointStatement(statement []token, words []string, dialect Dialect) (savepointOp, bool) {
	name := func(index int) string {
		if index < len(statement) && (statement[index].kind == tokIdent || statement[index].kind == tokWord) {
			return statement[index].value // the journal compares names case-insensitively
		}
		return ""
	}
	skip := func(index int, optional ...string) int {
		for index < len(statement) && statement[index].kind == tokWord {
			matched := false
			for _, word := range optional {
				if statement[index].value == word {
					matched = true
				}
			}
			if !matched {
				break
			}
			index++
		}
		return index
	}
	if dialect == DialectSQLServer {
		switch {
		case words[0] == "SAVE":
			return savepointOp{"create", strings.ToUpper(name(skip(1, "TRAN", "TRANSACTION")))}, true
		case words[0] == "ROLLBACK":
			index := skip(1, "TRAN", "TRANSACTION", "WORK")
			if value := name(index); value != "" {
				return savepointOp{"rollback", strings.ToUpper(value)}, true
			}
		}
		return savepointOp{}, false
	}
	switch words[0] {
	case "SAVEPOINT":
		return savepointOp{"create", strings.ToUpper(name(1))}, true
	case "RELEASE":
		return savepointOp{"release", strings.ToUpper(name(skip(1, "SAVEPOINT")))}, true
	case "ROLLBACK":
		index := skip(1, "TRANSACTION", "WORK")
		if index < len(statement) && statement[index].word("TO") {
			return savepointOp{"rollback", strings.ToUpper(name(skip(index+1, "SAVEPOINT")))}, true
		}
	}
	return savepointOp{}, false
}

// mysqlImplicitCommit lists statements that make MySQL commit the open
// transaction before they run.
var mysqlImplicitCommit = map[string]bool{
	"ALTER": true, "CREATE": true, "DROP": true, "RENAME": true, "TRUNCATE": true,
	"LOCK": true, "UNLOCK": true, "GRANT": true, "REVOKE": true, "ANALYZE": true,
	"OPTIMIZE": true, "REPAIR": true, "CHECK": true, "CACHE": true, "FLUSH": true,
	"RESET": true, "INSTALL": true, "UNINSTALL": true, "CHANGE": true, "STOP": true,
	"XA": true, "IMPORT": true, "CALL": true, "BEGIN": true, "START": true,
}

// sqlServerStatements are the keywords a T-SQL batch can start with. SQL Server
// runs a batch that starts with any other name as a procedure call, even without
// EXEC, so sp_executesql N'COMMIT' would end the preview transaction.
var sqlServerStatements = map[string]bool{
	"ALTER": true, "BACKUP": true, "BEGIN": true, "BREAK": true, "BULK": true, "CHECKPOINT": true,
	"CLOSE": true, "COMMIT": true, "CONTINUE": true, "CREATE": true, "DBCC": true, "DEALLOCATE": true,
	"DECLARE": true, "DELETE": true, "DENY": true, "DISABLE": true, "DROP": true, "ELSE": true,
	"ENABLE": true, "END": true, "EXEC": true, "EXECUTE": true, "FETCH": true, "GET": true, "GOTO": true,
	"GRANT": true, "IF": true, "INSERT": true, "KILL": true, "MERGE": true, "MOVE": true, "OPEN": true,
	"PRINT": true, "RAISERROR": true, "READTEXT": true, "RECEIVE": true, "RECONFIGURE": true,
	"RESTORE": true, "RETURN": true, "REVERT": true, "REVOKE": true, "ROLLBACK": true, "SAVE": true,
	"SELECT": true, "SEND": true, "SET": true, "SETUSER": true, "SHUTDOWN": true, "THROW": true,
	"TRUNCATE": true, "UPDATE": true, "UPDATETEXT": true, "USE": true, "WAITFOR": true, "WHILE": true,
	"WITH": true, "WRITETEXT": true,
}

// previewSavepoint is the savepoint a MySQL preview sets when it starts and
// releases before it rolls back. Any commit erases every savepoint, so a missing
// one proves the preview transaction was committed (spec/data-stores.md). No ORM
// generates this name, and the handler may not set, release or roll back to it.
const previewSavepoint = "sendproof_preview"

// previewSafe refuses a text that could end the preview transaction, with no
// procedure declared safe.
func previewSafe(text string, info statementInfo, dialect Dialect) error {
	return previewSafeWith(text, info, dialect, nil)
}

// previewSafeWith refuses a text that could end the preview transaction. A MySQL
// CALL is allowed only to a procedure in safe (see WithSafeProcedures). MySQL and
// PostgreSQL texts are checked under both readings of their string literals,
// because a session setting the provider cannot see decides whether a backslash
// escapes a quote; refusing when either reading is unsafe keeps the guard sound.
func previewSafeWith(text string, info statementInfo, dialect Dialect, safe map[string]bool) error {
	if err := checkPreviewSafeWith(text, info, dialect, safe); err != nil {
		return err
	}
	if dialect == DialectMySQL || dialect == DialectPostgres {
		return checkPreviewSafeWith(text, analyzeTokens(lexWith(text, dialect, true), dialect), dialect, safe)
	}
	return nil
}

// checkPreviewSafe refuses statements that could commit or end the preview
// transaction, with no procedure declared safe.
func checkPreviewSafe(info statementInfo, dialect Dialect) error {
	return checkPreviewSafeWith("", info, dialect, nil)
}

// checkPreviewSafeWith refuses statements that could commit or end the preview
// transaction. Savepoint statements are allowed: the journal follows them. text
// is the source of info's tokens, read for the case of a called procedure's name.
func checkPreviewSafeWith(text string, info statementInfo, dialect Dialect, safe map[string]bool) error {
	refuse := func(statement []token, why string) error {
		words := strings.Join(leadingWords(statement, 3), " ")
		return fmt.Errorf("%w: %s (%s)", ErrUnsafeStatement, words, why)
	}
	for _, statement := range info.statements {
		if err := checkStatement(text, statement, dialect, safe, refuse); err != nil {
			return err
		}
	}
	return checkSQLServerBatch(info, dialect, refuse)
}

// checkStatement refuses one statement that could commit or end the preview
// transaction.
func checkStatement(text string, statement []token, dialect Dialect, safe map[string]bool, refuse func([]token, string) error) error {
	words := leadingWords(statement, 4)
	if len(words) == 0 {
		return nil
	}
	if op, ok := savepointStatement(statement, words, dialect); ok {
		// Every dialect's backstop relies on this savepoint, so a handler may not touch it.
		if op.name == strings.ToUpper(previewSavepoint) {
			return refuse(statement, "the preview's own savepoint proves nothing committed it")
		}
		return nil
	}
	switch words[0] {
	case "COMMIT", "ROLLBACK", "ABORT":
		return refuse(statement, "transaction control; use BeginTx for application transactions")
	case "END":
		if dialect != DialectSQLServer {
			return refuse(statement, "transaction control")
		}
	case "BEGIN", "START":
		if dialect != DialectSQLServer || len(words) > 1 && (words[1] == "TRAN" || words[1] == "TRANSACTION" || words[1] == "DISTRIBUTED") {
			return refuse(statement, "transaction control; use BeginTx for application transactions")
		}
	case "PREPARE":
		if len(words) > 1 && words[1] == "TRANSACTION" {
			return refuse(statement, "two-phase commit")
		}
	}
	switch dialect {
	case DialectSQLite:
		switch words[0] {
		case "ATTACH", "DETACH", "VACUUM":
			return refuse(statement, "it changes databases outside the preview transaction")
		}
	case DialectMySQL:
		if len(words) > 1 && words[0] == "SET" && words[1] == "STATEMENT" {
			// MariaDB's SET STATEMENT var = value FOR <statement> runs the inner statement.
			for index, tok := range statement {
				if tok.word("FOR") {
					return checkStatement(text, statement[index+1:], dialect, safe, refuse)
				}
			}
			return refuse(statement, "SET STATEMENT without FOR")
		}
		if words[0] == "CALL" {
			// MySQL routine names ignore case, so the declared names and the call are compared lower-cased.
			if name, ok := calledProcedure(text, statement); ok && safe[strings.ToLower(name)] {
				return nil
			}
			return refuse(statement, "a procedure can commit the preview transaction; declare procedures that never commit with WithSafeProcedures")
		}
		if words[0] == "PREPARE" || words[0] == "EXECUTE" {
			return refuse(statement, "a prepared SQL statement can commit the preview transaction")
		}
		if mysqlImplicitCommit[words[0]] && !temporaryTable(words) || mysqlImplicitCommitPhrase(words) {
			return refuse(statement, "MySQL commits the open transaction before this statement")
		}
		if words[0] == "SET" && containsWord(statement, "AUTOCOMMIT", "@@AUTOCOMMIT", "@@SESSION.AUTOCOMMIT") {
			return refuse(statement, "changing autocommit commits the transaction")
		}
	case DialectSQLServer:
		if words[0] == "EXEC" || words[0] == "EXECUTE" {
			return refuse(statement, "a procedure can commit the preview transaction")
		}
		// ON makes the statement after a commit open a new transaction, which hides
		// the commit; OFF leaves the open transaction alone (EF Core sends it).
		if words[0] == "SET" && containsWord(statement, "IMPLICIT_TRANSACTIONS") && !implicitTransactionsOff(statement) {
			return refuse(statement, "implicit transactions change commit behavior")
		}
	}
	return nil
}

// implicitTransactionsOff reports whether a SQL Server statement is exactly
// SET IMPLICIT_TRANSACTIONS OFF, so an option list that also names it, such as
// SET NOCOUNT, IMPLICIT_TRANSACTIONS ON, stays refused.
func implicitTransactionsOff(statement []token) bool {
	want := []string{"SET", "IMPLICIT_TRANSACTIONS", "OFF"}
	if len(statement) != len(want) {
		return false
	}
	for i, word := range want {
		if statement[i].kind != tokWord || statement[i].value != word {
			return false
		}
	}
	return true
}

// calledProcedure reads the procedure a MySQL CALL names, as `name` or
// `schema.name` with the case written, from bare or backtick-quoted identifiers.
// It reports false when the name can't be read, or something other than an
// argument list follows it, so the call is refused.
func calledProcedure(text string, statement []token) (string, bool) {
	name, next, ok := procedureName(text, statement)
	if !ok || next < len(statement) && !statement[next].is(tokPunct, "(") {
		return "", false
	}
	return name, true
}

// procedureName reads the name after CALL and the index of the token after it.
func procedureName(text string, statement []token) (string, int, bool) {
	index := 0
	for index < len(statement) && !statement[index].word("CALL") {
		index++
	}
	part := func(at int) (string, bool) {
		if at >= len(statement) {
			return "", false
		}
		tok := statement[at]
		switch {
		case tok.kind == tokIdent && tok.end <= len(text) && strings.HasPrefix(text[tok.start:tok.end], "`"):
			return tok.value, true
		case tok.kind == tokWord && tok.end <= len(text):
			return text[tok.start:tok.end], true
		}
		return "", false
	}
	first, ok := part(index + 1)
	if !ok {
		return "", 0, false
	}
	name, next := first, index+2
	if next < len(statement) && statement[next].is(tokPunct, ".") {
		second, ok := part(next + 1)
		if !ok {
			return "", 0, false
		}
		name, next = first+"."+second, next+2
	}
	return name, next, true
}

// safeProcedureSet checks and copies the names WithSafeProcedures declares:
// exact `name` or `schema.name`, optionally backtick-quoted, with nothing else,
// so no wildcards or argument lists.
func safeProcedureSet(names []string) (map[string]bool, error) {
	set := make(map[string]bool, len(names))
	for _, raw := range names {
		source := "CALL " + strings.TrimSpace(raw)
		tokens := lex(source, DialectMySQL)
		name, next, ok := procedureName(source, tokens)
		if !ok || next != len(tokens) {
			return nil, fmt.Errorf("dbsql: safe procedure names are exact names, such as \"name\" or \"schema.name\": %q", raw)
		}
		set[strings.ToLower(name)] = true
	}
	return set, nil
}

// checkSQLServerBatch refuses a T-SQL batch that could commit or end the preview
// transaction anywhere in it.
func checkSQLServerBatch(info statementInfo, dialect Dialect, refuse func([]token, string) error) error {
	if dialect == DialectSQLServer {
		if first := firstToken(info.tokens); first.kind == tokIdent || first.kind == tokWord && !sqlServerStatements[first.value] {
			return refuse(info.tokens, "a batch that starts with a name calls that procedure, which can commit the preview transaction")
		}
		// T-SQL does not need semicolons between statements, so scan the whole batch.
		for index, tok := range info.tokens {
			next := func(offset int) token {
				if index+offset < len(info.tokens) {
					return info.tokens[index+offset]
				}
				return token{}
			}
			switch {
			case tok.word("COMMIT"):
				return refuse(info.tokens[index:], "transaction control")
			case tok.word("BEGIN") && (next(1).word("TRAN") || next(1).word("TRANSACTION") || next(1).word("DISTRIBUTED")):
				return refuse(info.tokens[index:], "transaction control")
			case tok.word("ROLLBACK"):
				following := 1
				if next(1).word("TRAN") || next(1).word("TRANSACTION") || next(1).word("WORK") {
					following = 2
				}
				if name := next(following); name.kind != tokWord && name.kind != tokIdent || name.value == "" {
					return refuse(info.tokens[index:], "rolling back the whole transaction")
				}
			case tok.word("EXEC") || tok.word("EXECUTE"):
				return refuse(info.tokens[index:], "a procedure can commit the preview transaction")
			}
		}
	}
	return nil
}

// mysqlImplicitCommitPhrase recognizes implicit-commit statements whose first
// keyword alone is ambiguous: SET PASSWORD, SET DEFAULT ROLE and LOAD INDEX INTO
// CACHE write to the mysql schema or the key cache and commit first.
func mysqlImplicitCommitPhrase(words []string) bool {
	if len(words) < 2 {
		return false
	}
	switch {
	case words[0] == "SET" && words[1] == "PASSWORD",
		words[0] == "SET" && words[1] == "DEFAULT" && len(words) > 2 && words[2] == "ROLE",
		words[0] == "LOAD" && words[1] == "INDEX":
		return true
	}
	return false
}

// firstToken returns the first token of a batch after any opening parentheses,
// or the zero token when there is none.
func firstToken(tokens []token) token {
	for _, tok := range tokens {
		if !tok.is(tokPunct, "(") {
			return tok
		}
	}
	return token{kind: tokPunct}
}

func temporaryTable(words []string) bool {
	return len(words) > 2 && (words[0] == "CREATE" || words[0] == "DROP") && words[1] == "TEMPORARY" && words[2] == "TABLE"
}
