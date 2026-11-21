package dbsql

import (
	"database/sql"
	"errors"
	"strings"
	"testing"
)

func TestLexerUnderstandsEachDialect(t *testing.T) {
	cases := []struct {
		dialect Dialect
		text    string
		params  []paramRef
	}{
		{DialectSQLite, "SELECT ?, ?3, @a, :b, $c FROM t WHERE x = '?'", []paramRef{{}, {position: 3}, {name: "a"}, {name: "b"}, {name: "c"}}},
		{DialectPostgres, "SELECT $1, $$ $2 $$, '$3', data ? 'k', x::text FROM t -- $4", []paramRef{{position: 1}}},
		{DialectMySQL, "SELECT ?, @user, \"?\" # ?\nFROM t", []paramRef{{}}},
		{DialectSQLServer, "SELECT @p1, @name, @@TRANCOUNT, [a?b], N'?' /* @p9 */", []paramRef{{name: "p1"}, {name: "name"}}},
	}
	for _, c := range cases {
		var got []paramRef
		for _, tok := range lex(c.text, c.dialect) {
			if tok.kind == tokParam {
				got = append(got, tok.param)
			}
		}
		if len(got) != len(c.params) {
			t.Errorf("%v %q: params %v, want %v", c.dialect, c.text, got, c.params)
			continue
		}
		for index := range got {
			if got[index] != c.params[index] {
				t.Errorf("%v %q: param %d = %v, want %v", c.dialect, c.text, index, got[index], c.params[index])
			}
		}
	}
}

func TestPreviewGuard(t *testing.T) {
	refused := map[Dialect][]string{
		DialectSQLite:    {"COMMIT", "end transaction", "BEGIN IMMEDIATE", "ROLLBACK", "SELECT 1; COMMIT"},
		DialectPostgres:  {"COMMIT", "ABORT", "START TRANSACTION", "PREPARE TRANSACTION 'x'", "COMMIT PREPARED 'x'"},
		DialectMySQL:     {"COMMIT", "BEGIN", "CREATE TABLE t (id int)", "ALTER TABLE t ADD c int", "TRUNCATE t", "LOCK TABLES t WRITE", "CALL p()", "SET autocommit = 1", "set @@autocommit=0"},
		DialectSQLServer: {"COMMIT", "BEGIN TRAN", "ROLLBACK", "ROLLBACK TRANSACTION", "UPDATE t SET a = 1 COMMIT", "EXEC dbo.p", "SET IMPLICIT_TRANSACTIONS ON"},
	}
	allowed := map[Dialect][]string{
		DialectSQLite:    {"SAVEPOINT a", "RELEASE a", "ROLLBACK TO a", "ROLLBACK TRANSACTION TO SAVEPOINT a", "SELECT 'COMMIT'", "CREATE TABLE t (id int)"},
		DialectPostgres:  {"SAVEPOINT a", "ROLLBACK TO SAVEPOINT a", "CREATE TABLE t (id int)", "DO $$ BEGIN COMMIT; END $$", "SELECT \"commit\" FROM t"},
		DialectMySQL:     {"SAVEPOINT a", "ROLLBACK TO a", "CREATE TEMPORARY TABLE t (id int)", "DROP TEMPORARY TABLE t", "INSERT INTO t VALUES ('COMMIT')"},
		DialectSQLServer: {"SAVE TRANSACTION a", "ROLLBACK TRANSACTION a", "IF 1 = 1 BEGIN UPDATE t SET a = 1 END", "SELECT [commit] FROM t"},
	}
	for dialect, statements := range refused {
		for _, statement := range statements {
			if err := checkPreviewSafe(analyze(statement, dialect), dialect); !errors.Is(err, ErrUnsafeStatement) {
				t.Errorf("%v must refuse %q, got %v", dialect, statement, err)
			}
		}
	}
	for dialect, statements := range allowed {
		for _, statement := range statements {
			if err := checkPreviewSafe(analyze(statement, dialect), dialect); err != nil {
				t.Errorf("%v must allow %q: %v", dialect, statement, err)
			}
		}
	}
}

func TestStatementClassification(t *testing.T) {
	readOnly := []string{"SELECT * FROM t", "WITH x AS (SELECT 1) SELECT * FROM x", "SHOW TABLES", "PRAGMA table_info(t)", "EXPLAIN SELECT 1"}
	for _, text := range readOnly {
		if analyze(text, DialectMySQL).mayWrite {
			t.Errorf("%q is read-only", text)
		}
	}
	writes := []string{"INSERT INTO t VALUES (1)", "WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x", "SELECT a INTO b FROM t", "PRAGMA user_version = 3", "MERGE INTO t USING s ON 1 = 1 WHEN MATCHED THEN DELETE"}
	for _, text := range writes {
		if !analyze(text, DialectPostgres).mayWrite {
			t.Errorf("%q may write", text)
		}
	}
	info := analyze("SAVEPOINT a; ROLLBACK TO SAVEPOINT a; RELEASE SAVEPOINT a", DialectPostgres)
	if len(info.savepoints) != 3 || info.savepoints[1] != (savepointOp{"rollback", "A"}) {
		t.Errorf("savepoints %v", info.savepoints)
	}
	if ops := analyze("SAVE TRAN sp1", DialectSQLServer).savepoints; len(ops) != 1 || ops[0] != (savepointOp{"create", "SP1"}) {
		t.Errorf("SQL Server savepoint %v", ops)
	}
}

func TestParseDML(t *testing.T) {
	parse := func(dialect Dialect, text string) *dml {
		t.Helper()
		info := analyze(text, dialect)
		plan, ok := parseDML(text, info.statements[0], dialect)
		if !ok {
			t.Fatalf("%v %q did not parse", dialect, text)
		}
		return plan
	}
	update := parse(DialectMySQL, "UPDATE `app`.`items` AS i SET name = ?, n = n + 1 WHERE i.id = ? ORDER BY id LIMIT 1")
	if update.table != (tableName{"app", "items"}) || update.aliasText != "i" || len(update.setColumns) != 2 || !update.hasLimit {
		t.Errorf("update %+v", update)
	}
	insert := parse(DialectPostgres, `INSERT INTO items (id, name) VALUES ($1, 'a'), ('x'::text, now()) ON CONFLICT (id) DO UPDATE SET name = excluded.name RETURNING id`)
	if len(insert.rows) != 2 || !insert.rows[0][0].usable || insert.rows[1][1].usable || !insert.upsert || !insert.returning || insert.conflict[0] != "id" {
		t.Errorf("insert %+v", insert)
	}
	output := parse(DialectSQLServer, `INSERT INTO [dbo].[notes] ([name]) VALUES (@p1)`)
	if output.table != (tableName{"dbo", "notes"}) || output.valuesAt != strings.Index(`INSERT INTO [dbo].[notes] ([name]) VALUES (@p1)`, "VALUES") {
		t.Errorf("SQL Server insert %+v", output)
	}
	if plan := parse(DialectMySQL, "INSERT IGNORE INTO t VALUES (1, 2)"); !plan.ignore || plan.columns != nil {
		t.Errorf("insert ignore %+v", plan)
	}
	for dialect, texts := range map[Dialect][]string{
		DialectMySQL:     {"UPDATE a JOIN b ON a.id = b.id SET a.x = 1", "DELETE a, b FROM a JOIN b", "INSERT INTO t SELECT * FROM s"},
		DialectPostgres:  {"UPDATE t SET x = 1 FROM s WHERE s.id = t.id", "DELETE FROM t USING s WHERE s.id = t.id", "UPDATE t SET x = 1 WHERE CURRENT OF c"},
		DialectSQLServer: {"UPDATE TOP (1) t SET x = 1", "DELETE t FROM t JOIN s ON s.id = t.id"},
	} {
		for _, text := range texts {
			info := analyze(text, dialect)
			if _, ok := parseDML(text, info.statements[0], dialect); ok {
				t.Errorf("%v %q must be left to the incomplete path", dialect, text)
			}
		}
	}
}

func TestBinderRenumbersPlaceholders(t *testing.T) {
	text := "UPDATE t SET a = $2 WHERE id = $1 AND b = $2"
	info := analyze(text, DialectPostgres)
	plan, _ := parseDML(text, info.statements[0], DialectPostgres)
	q := &query{dialect: DialectPostgres}
	if !q.copyTokens(text, plan.where, newBinder(info.tokens, []any{"key", "value"}, DialectPostgres)) {
		t.Fatal("binding failed")
	}
	if q.text.String() != "id = $1 AND b = $2" || q.args[0] != "key" || q.args[1] != "value" {
		t.Errorf("%q %v", q.text.String(), q.args)
	}
	named := "UPDATE t SET a = @p1 WHERE id = @id"
	info = analyze(named, DialectSQLServer)
	plan, _ = parseDML(named, info.statements[0], DialectSQLServer)
	q = &query{dialect: DialectSQLServer}
	q.copyTokens(named, plan.where, newBinder(info.tokens, []any{"v", sql.Named("id", 7)}, DialectSQLServer))
	if q.text.String() != "id = @p1" || q.args[0] != 7 {
		t.Errorf("%q %v", q.text.String(), q.args)
	}
}

func TestJournalFollowsSavepointsAndCaps(t *testing.T) {
	var j journal
	add := func(id string) { j.add(rowEvent{operation: "insert", key: map[string]any{"id": id}}) }
	add("a")
	j.savepoint(savepointOp{"create", "S"})
	add("b")
	j.savepoint(savepointOp{"rollback", "S"})
	add("c")
	j.savepoint(savepointOp{"release", "S"})
	events, truncated := j.events(true)
	if len(events) != 2 || events[1].key["id"] != "c" || truncated {
		t.Fatalf("events %v truncated %v", events, truncated)
	}
	j.commit()
	add("pending")
	if events, _ := j.events(false); len(events) != 2 {
		t.Errorf("uncommitted events must not count: %v", events)
	}
	j.rollback()

	var capped journal
	capped.savepoint(savepointOp{"create", "S"})
	for index := 0; index < maxEvents+10; index++ {
		capped.add(rowEvent{operation: "insert"})
	}
	if _, truncated := capped.events(true); !truncated {
		t.Error("events beyond the cap must report truncation")
	}
	capped.savepoint(savepointOp{"rollback", "S"})
	if events, truncated := capped.events(true); len(events) != 0 || truncated {
		t.Errorf("a rollback to the savepoint must discard the dropped events too: %d %v", len(events), truncated)
	}
}

func TestToChangesSkipsUnchangedUpdates(t *testing.T) {
	changes := toChanges([]rowEvent{
		{table: tableName{name: "t"}, operation: "update", key: map[string]any{"id": 1}, before: map[string]any{"a": 1}, after: map[string]any{"a": 1}},
		{table: tableName{schema: "s", name: "t"}, operation: "delete", key: map[string]any{"id": 2}, before: map[string]any{"a": 2}},
	})
	if len(changes) != 1 || changes[0].Table != "s.t" || changes[0].After != nil {
		t.Errorf("%+v", changes)
	}
}

// TestMySQLEscapesAreRefused covers spec/data-stores.md "Transaction-control
// statements from the handler" on MySQL: CALL except to declared procedures,
// SQL-level prepared statements, MariaDB's SET STATEMENT ... FOR, and the
// savepoint behind the commit backstop.
func TestMySQLEscapesAreRefused(t *testing.T) {
	safe, err := safeProcedureSet([]string{"audit_read", "`app`.`lookup`"})
	if err != nil {
		t.Fatal(err)
	}
	refused := []string{"CALL p()", "CALL other.audit_read()", "CALL AUDIT_READ()", "CALL audit_read_all()", "CALL lookup(1)", `CALL "audit_read"()`,
		"PREPARE s FROM 'COMMIT'", "EXECUTE s", "SET STATEMENT max_statement_time = 1 FOR COMMIT",
		"SET STATEMENT max_statement_time = 1 FOR CREATE TABLE t (n INT)", "SET sql_mode = '', autocommit = 1",
		"SAVEPOINT sendproof_preview", "RELEASE SAVEPOINT sendproof_preview", "ROLLBACK TO SAVEPOINT `sendproof_preview`", "ROLLBACK WORK TO SENDPROOF_PREVIEW"}
	allowed := []string{"CALL audit_read()", "CALL `audit_read`", "CALL app.lookup(1)", "CALL `app` . `lookup`()",
		"SET STATEMENT max_statement_time = 1 FOR SELECT 1", "DEALLOCATE PREPARE s", "SAVEPOINT sp1", "RELEASE SAVEPOINT sp1"}
	for _, statement := range refused {
		if err := previewSafeWith(statement, analyze(statement, DialectMySQL), DialectMySQL, safe); !errors.Is(err, ErrUnsafeStatement) {
			t.Errorf("MySQL must refuse %q, got %v", statement, err)
		}
	}
	for _, statement := range allowed {
		if err := previewSafeWith(statement, analyze(statement, DialectMySQL), DialectMySQL, safe); err != nil {
			t.Errorf("MySQL must allow %q: %v", statement, err)
		}
	}
	for _, name := range []string{"", "p%", "p*", "a.b.c", "p()", "p q"} {
		if _, err := safeProcedureSet([]string{name}); err == nil {
			t.Errorf("a safe procedure name must be exact: %q was accepted", name)
		}
	}
}

func TestPreviewGuardSeesThroughQuotingAndComments(t *testing.T) {
	refused := map[Dialect][]string{
		// MySQL runs the body of /*! */ and /*M! */ comments, and "--" without a
		// following space is two minus signs.
		DialectMySQL: {"/*! COMMIT */", "SELECT 1; /*!50000 COMMIT */", "/*M!100000 DROP TABLE t */", "SELECT 1 --1; COMMIT",
			"SET PASSWORD = 'x'", "SET DEFAULT ROLE r TO u", "LOAD INDEX INTO CACHE t",
			// Under NO_BACKSLASH_ESCAPES or ANSI_QUOTES the quote ends at the backslash.
			`SELECT 'a\'; COMMIT; SELECT '`, `SELECT "a\"; COMMIT; -- "`},
		// With standard_conforming_strings off a backslash escapes the quote.
		DialectPostgres:  {`SELECT 'x\''; COMMIT; SELECT '`},
		DialectSQLite:    {"ATTACH DATABASE 'copy.db' AS copy", "DETACH copy", "VACUUM INTO 'copy.db'"},
		DialectSQLServer: {"sp_executesql N'COMMIT TRANSACTION'", "dbo.archive_items", "[dbo].[archive_items] 1"},
	}
	allowed := map[Dialect][]string{
		DialectMySQL: {"SELECT 1 -- COMMIT", "SELECT 1 /* COMMIT */", "SELECT /*+ BKA(t) */ * FROM t", "SELECT 2--1",
			`INSERT INTO t VALUES ('it\'s')`, "/*!40101 SET NAMES utf8mb4 */"},
		DialectPostgres:  {`SELECT E'it\'s'`, "SELECT 'a''b'"},
		DialectSQLServer: {"SELECT 1", "(SELECT 1)", "WITH x AS (SELECT 1) SELECT * FROM x", "SAVE TRANSACTION a", "INSERT INTO t VALUES (1)", "SET NOCOUNT ON"},
	}
	for dialect, statements := range refused {
		for _, statement := range statements {
			if err := previewSafe(statement, analyze(statement, dialect), dialect); !errors.Is(err, ErrUnsafeStatement) {
				t.Errorf("%v must refuse %q, got %v", dialect, statement, err)
			}
		}
	}
	for dialect, statements := range allowed {
		for _, statement := range statements {
			if err := previewSafe(statement, analyze(statement, dialect), dialect); err != nil {
				t.Errorf("%v must allow %q: %v", dialect, statement, err)
			}
		}
	}
	var params int
	for _, tok := range lex("SELECT /*! ? */ 1", DialectMySQL) {
		if tok.kind == tokParam {
			params++
		}
	}
	if params != 1 {
		t.Errorf("a placeholder in an executable comment was not seen: %d", params)
	}
}

func TestReturningIsAddedAfterTheLastToken(t *testing.T) {
	text := "INSERT INTO items (name) VALUES ($1) -- create an item"
	info := analyze(text, DialectPostgres)
	plan, ok := parseDML(text, info.statements[0], DialectPostgres)
	if !ok {
		t.Fatal("did not parse")
	}
	k := &keyedStatement{plan: plan, meta: &tableMeta{key: []string{"id"}}, source: text, generated: "returning"}
	if got, want := k.generatedSQL(DialectPostgres), `INSERT INTO items (name) VALUES ($1) RETURNING "id"`; got != want {
		t.Errorf("generatedSQL = %q, want %q", got, want)
	}
}

func TestDatabaseLabelMustBeBare(t *testing.T) {
	for _, label := range []string{"postgres://app:pw@db/app", "file:/var/lib/app.db", "Server=db;Password=pw", "app@db"} {
		if err := WithDatabaseLabel(label)(&config{}); err == nil {
			t.Errorf("label %q was accepted", label)
		}
	}
	if err := WithDatabaseLabel("Inventory")(&config{}); err != nil {
		t.Error(err)
	}
}

func TestDialectsNameTheirDiscoverySystem(t *testing.T) {
	for dialect, want := range map[Dialect]string{
		DialectSQLite: "sqlite", DialectPostgres: "postgresql", DialectMySQL: "mysql", DialectSQLServer: "sqlserver", DialectAuto: "",
	} {
		if got := dialect.System(); got != want {
			t.Errorf("%s: System() = %q, want %q", dialect, got, want)
		}
	}
}
