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
	tokens := lex(text, dialect)
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

// checkPreviewSafe refuses statements that could commit or end the preview
// transaction. Savepoint statements are allowed: the journal follows them.
func checkPreviewSafe(info statementInfo, dialect Dialect) error {
	refuse := func(statement []token, why string) error {
		words := strings.Join(leadingWords(statement, 3), " ")
		return fmt.Errorf("%w: %s (%s)", ErrUnsafeStatement, words, why)
	}
	for _, statement := range info.statements {
		words := leadingWords(statement, 4)
		if len(words) == 0 {
			continue
		}
		if _, ok := savepointStatement(statement, words, dialect); ok {
			continue
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
		case DialectMySQL:
			if mysqlImplicitCommit[words[0]] && !temporaryTable(words) {
				return refuse(statement, "MySQL commits the open transaction before this statement")
			}
			if words[0] == "SET" && containsWord(statement, "AUTOCOMMIT", "@@AUTOCOMMIT", "@@SESSION.AUTOCOMMIT") {
				return refuse(statement, "changing autocommit commits the transaction")
			}
		case DialectSQLServer:
			if words[0] == "EXEC" || words[0] == "EXECUTE" {
				return refuse(statement, "a procedure can commit the preview transaction")
			}
			if words[0] == "SET" && containsWord(statement, "IMPLICIT_TRANSACTIONS") {
				return refuse(statement, "implicit transactions change commit behavior")
			}
		}
	}
	if dialect == DialectSQLServer {
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

func temporaryTable(words []string) bool {
	return len(words) > 2 && (words[0] == "CREATE" || words[0] == "DROP") && words[1] == "TEMPORARY" && words[2] == "TABLE"
}
