package dbsql

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Keyed capture serves MySQL and SQL Server, and PostgreSQL observed sends. For
// each single-table INSERT, REPLACE, UPDATE or DELETE it reads the affected rows
// by primary key around the statement, on the same connection and inside the
// same transaction:
//
//   - UPDATE and DELETE first select the rows their WHERE clause matches with a
//     locking read (FOR UPDATE, or UPDLOCK and HOLDLOCK on SQL Server), so no
//     other transaction can change them before the statement does. After the
//     statement the updated rows are read back by key.
//   - INSERT takes the keys from its VALUES list. Generated keys come from
//     LAST_INSERT_ID on MySQL, an added OUTPUT INSERTED clause on SQL Server and
//     an added RETURNING clause on PostgreSQL. Upserts and INSERT IGNORE also
//     read the named keys first, to tell an insert from an update or a no-op.
//
// The inserted and updated rows stay locked until the transaction ends, so the
// rows read back are exactly the statement's result. Writes the statement causes
// elsewhere, through triggers or foreign-key actions, are not read: the capture
// is then marked incomplete and the trace carries a warning. Statements of any
// other shape run unchanged and are reported the same way.

// keyedStatement is the plan and captured state of one statement.
type keyedStatement struct {
	plan   *dml
	meta   *tableMeta
	binder binder
	source string

	// before holds the rows read ahead of the statement, by key string.
	before      []keyedRow
	beforeByKey map[string]keyedRow
	// keys are the rows to read afterwards, in order.
	keys [][]keyPart
	// generated selects how an INSERT learns keys the database generates.
	generated string // "", "lastInsertId", "returning" or "output"
	// problem explains why the capture is incomplete.
	problem string
}

// keyPart is one key column value, bound as a parameter or copied as a literal.
type keyPart struct {
	value   any
	literal string
}

type keyedRow struct {
	key    map[string]any
	values map[string]any
}

// plan prepares keyed capture of one statement and runs its locking pre-read.
// It returns nil, problem when the statement cannot be captured.
func (s *scope) planKeyed(ctx context.Context, source rowSource, text string, info statementInfo, args []any, query bool) (*keyedStatement, string) {
	if len(info.statements) != 1 {
		return nil, "a text with several statements"
	}
	plan, ok := parseDML(text, info.statements[0], s.dialect)
	if !ok {
		return nil, "a statement shape that keyed capture does not read"
	}
	meta, err := s.tableMeta(ctx, source, plan)
	if err != nil {
		return nil, err.Error()
	}
	if len(meta.key) == 0 {
		return nil, fmt.Sprintf("table %s has no primary key", plan.table)
	}
	k := &keyedStatement{plan: plan, meta: meta, binder: newBinder(info.tokens, args, s.dialect), source: text, beforeByKey: map[string]keyedRow{}}
	if meta.sideEffects(plan.operation, plan.upsert) {
		k.problem = fmt.Sprintf("triggers or foreign-key actions on %s change rows that are not shown", plan.table)
	}
	switch plan.operation {
	case "update", "delete":
		for _, column := range plan.setColumns {
			if meta.keyColumn(column) {
				return nil, fmt.Sprintf("an UPDATE that changes the primary key of %s", plan.table)
			}
		}
		if err := k.readBefore(ctx, source, s.dialect, true); err != nil {
			return nil, err.Error()
		}
	default:
		if problem := k.insertKeys(s.dialect, query); problem != "" {
			return nil, problem
		}
		if (plan.upsert || plan.ignore || plan.operation == "replace") && len(k.keys) > 0 {
			rows, err := k.readKeys(ctx, source, s.dialect, k.keys, true)
			if err != nil {
				return nil, err.Error()
			}
			for _, row := range rows {
				k.before = append(k.before, row)
				k.beforeByKey[keyString(row.key, meta.key)] = row
			}
		}
	}
	return k, ""
}

// addKey records a row to read back. Keys past maxEvents are not kept: the
// workbench would not show their changes, and the statement is reported as
// changing more rows than are shown.
func (k *keyedStatement) addKey(parts []keyPart) {
	if len(k.keys) >= maxEvents {
		k.problem = "the statement changed more rows than are shown"
		return
	}
	k.keys = append(k.keys, parts)
}

// insertKeys works out the key of each inserted row.
func (k *keyedStatement) insertKeys(dialect Dialect, query bool) string {
	plan, meta := k.plan, k.meta
	columns := plan.columns
	if columns == nil && !plan.defaultValues {
		columns = meta.columns
	}
	positions := make([]int, len(meta.key))
	missing := false
	for index, key := range meta.key {
		positions[index] = -1
		for position, column := range columns {
			if strings.EqualFold(column, key) {
				positions[index] = position
			}
		}
		if positions[index] < 0 {
			missing = true
			if !meta.generated[key] {
				return fmt.Sprintf("an INSERT into %s that omits key column %s", plan.table, key)
			}
		}
	}
	if missing {
		switch {
		case plan.upsert || plan.ignore || plan.operation == "replace":
			return fmt.Sprintf("an upsert into %s that relies on a generated key", plan.table)
		case query || plan.returning:
			return fmt.Sprintf("an INSERT into %s whose generated keys only the application reads", plan.table)
		case dialect == DialectMySQL && len(meta.key) == 1:
			k.generated = "lastInsertId"
		case dialect == DialectPostgres:
			k.generated = "returning"
		case dialect == DialectSQLServer && !meta.triggers["insert"]:
			k.generated = "output"
		default:
			return fmt.Sprintf("an INSERT into %s whose generated keys cannot be read", plan.table)
		}
		return ""
	}
	if (plan.upsert || plan.operation == "replace") && meta.otherUnique && !sameColumns(plan.conflict, meta.key) {
		return fmt.Sprintf("an upsert into %s that may match a row through another unique key", plan.table)
	}
	for _, row := range plan.rows {
		key := make([]keyPart, len(meta.key))
		for index, position := range positions {
			if position >= len(row) || !row[position].usable {
				return fmt.Sprintf("an INSERT into %s whose key is an expression", plan.table)
			}
			tok := row[position].tok
			if tok.kind == tokParam {
				value, ok := k.binder.value(tok)
				if !ok {
					return "an INSERT whose key argument is missing"
				}
				key[index] = keyPart{value: value}
			} else {
				key[index] = keyPart{literal: k.source[tok.start:tok.end], value: tok.value}
			}
		}
		k.addKey(key)
	}
	return ""
}

func sameColumns(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for index := range a {
		if !strings.EqualFold(a[index], b[index]) {
			return false
		}
	}
	return true
}

// readBefore selects the rows an UPDATE or DELETE matches, locking them.
func (k *keyedStatement) readBefore(ctx context.Context, source rowSource, dialect Dialect, lock bool) error {
	plan := k.plan
	q := &query{dialect: dialect}
	q.write("SELECT ")
	if dialect == DialectSQLServer {
		q.write(fmt.Sprintf("TOP (%d) ", maxEvents+1))
	}
	q.write("* FROM ", plan.tableText)
	if plan.aliasText != "" {
		q.write(" ", dialect.quoteIdent(plan.aliasText))
	}
	if lock && dialect == DialectSQLServer {
		q.write(" WITH (UPDLOCK, HOLDLOCK)")
	}
	if len(plan.where) > 0 {
		q.write(" WHERE ")
		if !q.copyTokens(k.source, plan.where, k.binder) {
			return errors.New("an argument of the WHERE clause is missing")
		}
	}
	if len(plan.tail) > 0 {
		q.write(" ")
		if !q.copyTokens(k.source, plan.tail, k.binder) {
			return errors.New("an argument of the LIMIT clause is missing")
		}
	}
	if dialect != DialectSQLServer && !plan.hasLimit {
		q.write(fmt.Sprintf(" LIMIT %d", maxEvents+1))
	}
	if lock && dialect != DialectSQLServer {
		q.write(" FOR UPDATE")
	}
	rows, err := readRows(ctx, source, dialect, q.text.String(), q.args)
	if err != nil {
		return fmt.Errorf("dbsql: read the rows a statement changes: %w", err)
	}
	if len(rows) > maxEvents {
		rows = rows[:maxEvents]
		k.problem = "the statement changed more rows than are shown"
	}
	for _, values := range rows {
		row := keyedRow{key: pickKey(values, k.meta.key), values: values}
		k.before = append(k.before, row)
		k.beforeByKey[keyString(row.key, k.meta.key)] = row
		parts := make([]keyPart, len(k.meta.key))
		for index, column := range k.meta.key {
			parts[index] = keyPart{value: row.key[column]}
		}
		k.addKey(parts)
	}
	return nil
}

// readKeys reads rows by primary key, in chunks.
func (k *keyedStatement) readKeys(ctx context.Context, source rowSource, dialect Dialect, keys [][]keyPart, lock bool) ([]keyedRow, error) {
	const chunk = 50
	var result []keyedRow
	for start := 0; start < len(keys); start += chunk {
		end := min(start+chunk, len(keys))
		q := &query{dialect: dialect}
		q.write("SELECT * FROM ", k.plan.tableText)
		if lock && dialect == DialectSQLServer {
			q.write(" WITH (UPDLOCK, HOLDLOCK)")
		}
		q.write(" WHERE ")
		for index, key := range keys[start:end] {
			if index > 0 {
				q.write(" OR ")
			}
			q.write("(")
			for part, column := range k.meta.key {
				if part > 0 {
					q.write(" AND ")
				}
				q.write(dialect.quoteIdent(column), " = ")
				if key[part].literal != "" {
					q.write(key[part].literal)
				} else {
					q.bind(key[part].value)
				}
			}
			q.write(")")
		}
		if lock && dialect != DialectSQLServer {
			q.write(" FOR UPDATE")
		}
		rows, err := readRows(ctx, source, dialect, q.text.String(), q.args)
		if err != nil {
			return nil, fmt.Errorf("dbsql: read changed rows by key: %w", err)
		}
		for _, values := range rows {
			result = append(result, keyedRow{key: pickKey(values, k.meta.key), values: values})
		}
	}
	return result, nil
}

// generatedSQL rewrites an INSERT so that it returns the keys it generates.
func (k *keyedStatement) generatedSQL(dialect Dialect) string {
	columns := make([]string, len(k.meta.key))
	switch k.generated {
	case "returning":
		for index, column := range k.meta.key {
			columns[index] = dialect.quoteIdent(column)
		}
		// Appending at the last token keeps a trailing -- comment from swallowing the clause.
		return k.source[:k.plan.end] + " RETURNING " + strings.Join(columns, ", ")
	case "output":
		for index, column := range k.meta.key {
			columns[index] = "INSERTED." + dialect.quoteIdent(column)
		}
		at := k.plan.valuesAt
		return k.source[:at] + "OUTPUT " + strings.Join(columns, ", ") + " " + k.source[at:]
	}
	return k.source
}

// addGeneratedKeys records keys returned by the rewritten INSERT.
func (k *keyedStatement) addGeneratedKeys(rows *sql.Rows) (int64, error) {
	defer rows.Close()
	var count int64
	for rows.Next() {
		values := make([]any, len(k.meta.key))
		pointers := make([]any, len(values))
		for index := range values {
			pointers[index] = &values[index]
		}
		if err := rows.Scan(pointers...); err != nil {
			return count, err
		}
		parts := make([]keyPart, len(values))
		for index, value := range values {
			parts[index] = keyPart{value: normalize(value)}
		}
		k.addKey(parts)
		count++
	}
	return count, rows.Err()
}

// addInsertIDs derives the keys of a MySQL multi-row INSERT from the first
// generated ID: InnoDB allocates the IDs of one simple INSERT consecutively, in
// steps of the session's auto_increment_increment, which it reads on the same
// connection.
func (k *keyedStatement) addInsertIDs(ctx context.Context, source rowSource, result sql.Result) error {
	first, err := result.LastInsertId()
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != int64(len(k.plan.rows)) {
		k.problem = "an INSERT whose generated keys could not be matched to its rows"
		return nil
	}
	step := int64(1)
	if affected > 1 {
		rows, err := queryStrings(ctx, source, "SELECT @@session.auto_increment_increment")
		if err != nil || len(rows) != 1 {
			k.problem = "an INSERT whose generated key step could not be read"
			return nil
		}
		if step, err = strconv.ParseInt(rows[0][0], 10, 64); err != nil || step < 1 {
			k.problem = "an INSERT whose generated key step could not be read"
			return nil
		}
	}
	for offset := int64(0); offset < affected; offset++ {
		k.addKey([]keyPart{{value: first + offset*step}})
	}
	return nil
}

// finish reads the rows back and returns the statement's events in order.
func (k *keyedStatement) finish(ctx context.Context, source rowSource, dialect Dialect, affected int64) ([]rowEvent, string, error) {
	var after []keyedRow
	if k.plan.operation != "delete" && len(k.keys) > 0 {
		var err error
		if after, err = k.readKeys(ctx, source, dialect, k.keys, false); err != nil {
			return nil, k.problem, err
		}
	}
	afterByKey := make(map[string]keyedRow, len(after))
	for _, row := range after {
		afterByKey[keyString(row.key, k.meta.key)] = row
	}
	var events []rowEvent
	table := k.plan.table
	switch k.plan.operation {
	case "delete":
		if affected >= 0 && affected != int64(len(k.before)) && k.problem == "" {
			k.problem = fmt.Sprintf("a DELETE on %s removed %d rows but %d were read", table, affected, len(k.before))
		}
		for _, row := range k.before {
			events = append(events, rowEvent{table: table, operation: "delete", key: row.key, before: row.values})
		}
	case "update":
		for _, row := range k.before {
			current, found := afterByKey[keyString(row.key, k.meta.key)]
			if !found {
				k.problem = fmt.Sprintf("an updated row of %s could not be read back", table)
				continue
			}
			events = append(events, rowEvent{table: table, operation: "update", key: row.key, before: row.values, after: current.values})
		}
	default:
		for _, key := range k.keys {
			id := partsString(key)
			previous, existed := k.beforeByKey[id]
			current, exists := afterByKey[id]
			if !exists {
				current, exists = lookupFold(afterByKey, id)
			}
			switch {
			case !existed && exists:
				events = append(events, rowEvent{table: table, operation: "insert", key: current.key, after: current.values})
			case existed && exists && k.plan.operation == "replace":
				events = append(events,
					rowEvent{table: table, operation: "delete", key: previous.key, before: previous.values},
					rowEvent{table: table, operation: "insert", key: current.key, after: current.values})
			case existed && exists:
				events = append(events, rowEvent{table: table, operation: "update", key: current.key, before: previous.values, after: current.values})
			case existed:
				events = append(events, rowEvent{table: table, operation: "delete", key: previous.key, before: previous.values})
			}
		}
	}
	return events, k.problem, nil
}

// lookupFold finds a row whose key differs only in letter case, as a
// case-insensitive collation stores it.
func lookupFold(rows map[string]keyedRow, id string) (keyedRow, bool) {
	for key, row := range rows {
		if strings.EqualFold(key, id) {
			return row, true
		}
	}
	return keyedRow{}, false
}

// readRows runs a query and returns its rows as column maps.
func readRows(ctx context.Context, source rowSource, dialect Dialect, text string, args []any) ([]map[string]any, error) {
	rows, err := source.QueryContext(ctx, text, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	var result []map[string]any
	for rows.Next() {
		values := make([]any, len(columns))
		pointers := make([]any, len(columns))
		for index := range values {
			pointers[index] = &values[index]
		}
		if err := rows.Scan(pointers...); err != nil {
			return nil, err
		}
		row := make(map[string]any, len(columns))
		for index, name := range columns {
			row[name] = normalize(values[index])
		}
		result = append(result, row)
	}
	return result, rows.Err()
}

// normalize turns driver byte slices that hold text into strings, as MySQL
// returns text columns.
func normalize(value any) any {
	if raw, ok := value.([]byte); ok && utf8.Valid(raw) {
		return string(raw)
	}
	return value
}

func pickKey(values map[string]any, columns []string) map[string]any {
	key := make(map[string]any, len(columns))
	for _, column := range columns {
		for name, value := range values {
			if strings.EqualFold(name, column) {
				key[column] = value
			}
		}
	}
	return key
}

func keyString(key map[string]any, columns []string) string {
	parts := make([]keyPart, len(columns))
	for index, column := range columns {
		parts[index] = keyPart{value: key[column]}
	}
	return partsString(parts)
}

func partsString(parts []keyPart) string {
	var b strings.Builder
	for index, part := range parts {
		if index > 0 {
			b.WriteByte(0)
		}
		fmt.Fprint(&b, part.value)
	}
	return b.String()
}

// countResult is the sql.Result of an INSERT that ran as a query to return keys.
type countResult int64

func (countResult) LastInsertId() (int64, error) {
	return 0, errors.New("dbsql: LastInsertId is not supported by this driver")
}

func (c countResult) RowsAffected() (int64, error) { return int64(c), nil }
