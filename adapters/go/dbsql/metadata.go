package dbsql

import (
	"context"
	"fmt"
	"strings"
)

// tableMeta is what keyed capture needs to know about a table: how rows are
// identified and which writes happen beyond the statement itself.
type tableMeta struct {
	columns []string // in table order, for INSERT without a column list
	key     []string // primary-key columns in key order
	// generated lists key columns the database fills when they are omitted:
	// identity, auto-increment and default values.
	generated map[string]bool
	// otherUnique reports unique constraints besides the primary key, which can
	// redirect an upsert to a row the statement does not name.
	otherUnique bool
	// triggers holds "insert", "update" and "delete" for enabled triggers.
	triggers map[string]bool
	// cascades holds "update" and "delete" when another table's foreign key
	// changes its own rows in response.
	cascades map[string]bool
}

// sideEffects reports whether a statement of the operation changes rows that
// keyed capture cannot see.
func (m *tableMeta) sideEffects(operation string, upsert bool) bool {
	switch operation {
	case "insert":
		return m.triggers["insert"] || upsert && (m.triggers["update"] || m.cascades["update"])
	case "replace":
		return m.triggers["insert"] || m.triggers["delete"] || m.cascades["delete"]
	}
	return m.triggers[operation] || m.cascades[operation]
}

func (m *tableMeta) keyColumn(name string) bool {
	for _, column := range m.key {
		if strings.EqualFold(column, name) {
			return true
		}
	}
	return false
}

// loadMeta reads a table's metadata on source. reference is the table as the
// statement spelled it, which PostgreSQL and SQL Server resolve themselves.
func loadMeta(ctx context.Context, source rowSource, dialect Dialect, table tableName, reference string) (*tableMeta, error) {
	meta := &tableMeta{generated: map[string]bool{}, triggers: map[string]bool{}, cascades: map[string]bool{}}
	var err error
	switch dialect {
	case DialectMySQL:
		err = loadMySQLMeta(ctx, source, table, meta)
	case DialectSQLServer:
		err = loadSQLServerMeta(ctx, source, reference, meta)
	case DialectPostgres:
		err = loadPostgresMeta(ctx, source, reference, meta)
	default:
		err = fmt.Errorf("dbsql: keyed capture does not support %s", dialect)
	}
	if err != nil {
		return nil, fmt.Errorf("dbsql: read the metadata of %s: %w", table, err)
	}
	if len(meta.columns) == 0 {
		return nil, fmt.Errorf("dbsql: table %s was not found", table)
	}
	return meta, nil
}

// queryStrings runs a query on source and returns each row's columns as strings.
func queryStrings(ctx context.Context, source rowSource, query string, args ...any) ([][]string, error) {
	rows, err := source.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	var result [][]string
	for rows.Next() {
		values := make([]any, len(columns))
		pointers := make([]any, len(columns))
		for index := range values {
			pointers[index] = &values[index]
		}
		if err := rows.Scan(pointers...); err != nil {
			return nil, err
		}
		row := make([]string, len(columns))
		for index, value := range values {
			switch typed := value.(type) {
			case nil:
			case []byte:
				row[index] = string(typed)
			default:
				row[index] = fmt.Sprint(typed)
			}
		}
		result = append(result, row)
	}
	return result, rows.Err()
}

func loadMySQLMeta(ctx context.Context, source rowSource, table tableName, meta *tableMeta) error {
	var schema any
	if table.schema != "" {
		schema = table.schema
	}
	columns, err := queryStrings(ctx, source, `SELECT COLUMN_NAME, COLUMN_KEY, EXTRA, COLUMN_DEFAULT IS NOT NULL
		FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, schema, table.name)
	if err != nil {
		return err
	}
	defaults := map[string]bool{}
	for _, column := range columns {
		meta.columns = append(meta.columns, column[0])
		defaults[column[0]] = strings.Contains(strings.ToLower(column[2]), "auto_increment") || column[3] == "1"
	}
	keys, err := queryStrings(ctx, source, `SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
		WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION`, schema, table.name)
	if err != nil {
		return err
	}
	for _, key := range keys {
		meta.key = append(meta.key, key[0])
		meta.generated[key[0]] = defaults[key[0]]
	}
	unique, err := queryStrings(ctx, source, `SELECT COUNT(DISTINCT INDEX_NAME) FROM information_schema.STATISTICS
		WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ? AND NON_UNIQUE = 0 AND INDEX_NAME <> 'PRIMARY'`, schema, table.name)
	if err != nil {
		return err
	}
	meta.otherUnique = len(unique) > 0 && unique[0][0] != "0"
	triggers, err := queryStrings(ctx, source, `SELECT EVENT_MANIPULATION FROM information_schema.TRIGGERS
		WHERE EVENT_OBJECT_SCHEMA = COALESCE(?, DATABASE()) AND EVENT_OBJECT_TABLE = ?`, schema, table.name)
	if err != nil {
		return err
	}
	for _, trigger := range triggers {
		meta.triggers[strings.ToLower(trigger[0])] = true
	}
	references, err := queryStrings(ctx, source, `SELECT UPDATE_RULE, DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS
		WHERE UNIQUE_CONSTRAINT_SCHEMA = COALESCE(?, DATABASE()) AND REFERENCED_TABLE_NAME = ?`, schema, table.name)
	if err != nil {
		return err
	}
	for _, reference := range references {
		meta.cascades["update"] = meta.cascades["update"] || changesRows(reference[0])
		meta.cascades["delete"] = meta.cascades["delete"] || changesRows(reference[1])
	}
	return nil
}

// changesRows reports a referential action that writes to the referencing rows.
func changesRows(rule string) bool {
	switch strings.ToUpper(strings.ReplaceAll(rule, "_", " ")) {
	case "CASCADE", "SET NULL", "SET DEFAULT", "1", "2", "3", "C", "N", "D":
		return true
	}
	return false
}

func loadSQLServerMeta(ctx context.Context, source rowSource, reference string, meta *tableMeta) error {
	columns, err := queryStrings(ctx, source, `SELECT c.name, CASE WHEN c.is_identity = 1 OR c.default_object_id <> 0 THEN 1 ELSE 0 END
		FROM sys.columns c WHERE c.object_id = OBJECT_ID(@p1) ORDER BY c.column_id`, reference)
	if err != nil {
		return err
	}
	defaults := map[string]bool{}
	for _, column := range columns {
		meta.columns = append(meta.columns, column[0])
		defaults[column[0]] = column[1] == "1"
	}
	keys, err := queryStrings(ctx, source, `SELECT c.name FROM sys.indexes i
		JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
		JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
		WHERE i.object_id = OBJECT_ID(@p1) AND i.is_primary_key = 1 ORDER BY ic.key_ordinal`, reference)
	if err != nil {
		return err
	}
	for _, key := range keys {
		meta.key = append(meta.key, key[0])
		meta.generated[key[0]] = defaults[key[0]]
	}
	unique, err := queryStrings(ctx, source, `SELECT COUNT(*) FROM sys.indexes WHERE object_id = OBJECT_ID(@p1) AND is_unique = 1 AND is_primary_key = 0`, reference)
	if err != nil {
		return err
	}
	meta.otherUnique = len(unique) > 0 && unique[0][0] != "0"
	triggers, err := queryStrings(ctx, source, `SELECT te.type_desc FROM sys.triggers t JOIN sys.trigger_events te ON te.object_id = t.object_id
		WHERE t.parent_id = OBJECT_ID(@p1) AND t.is_disabled = 0`, reference)
	if err != nil {
		return err
	}
	for _, trigger := range triggers {
		meta.triggers[strings.ToLower(trigger[0])] = true
	}
	references, err := queryStrings(ctx, source, `SELECT update_referential_action, delete_referential_action FROM sys.foreign_keys
		WHERE referenced_object_id = OBJECT_ID(@p1)`, reference)
	if err != nil {
		return err
	}
	for _, reference := range references {
		meta.cascades["update"] = meta.cascades["update"] || changesRows(reference[0])
		meta.cascades["delete"] = meta.cascades["delete"] || changesRows(reference[1])
	}
	return nil
}

func loadPostgresMeta(ctx context.Context, source rowSource, reference string, meta *tableMeta) error {
	columns, err := queryStrings(ctx, source, `SELECT a.attname, (a.attidentity <> '' OR a.atthasdef)::int
		FROM pg_attribute a WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, reference)
	if err != nil {
		return err
	}
	defaults := map[string]bool{}
	for _, column := range columns {
		meta.columns = append(meta.columns, column[0])
		defaults[column[0]] = column[1] == "1"
	}
	keys, err := queryStrings(ctx, source, `SELECT a.attname FROM pg_index i
		CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
		JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
		WHERE i.indrelid = to_regclass($1) AND i.indisprimary ORDER BY k.ord`, reference)
	if err != nil {
		return err
	}
	for _, key := range keys {
		meta.key = append(meta.key, key[0])
		meta.generated[key[0]] = defaults[key[0]]
	}
	unique, err := queryStrings(ctx, source, `SELECT count(*) FROM pg_index WHERE indrelid = to_regclass($1) AND indisunique AND NOT indisprimary`, reference)
	if err != nil {
		return err
	}
	meta.otherUnique = len(unique) > 0 && unique[0][0] != "0"
	triggers, err := queryStrings(ctx, source, `SELECT (tgtype & 4 <> 0)::int, (tgtype & 8 <> 0)::int, (tgtype & 16 <> 0)::int
		FROM pg_trigger WHERE tgrelid = to_regclass($1) AND NOT tgisinternal AND tgenabled <> 'D'`, reference)
	if err != nil {
		return err
	}
	for _, trigger := range triggers {
		meta.triggers["insert"] = meta.triggers["insert"] || trigger[0] == "1"
		meta.triggers["delete"] = meta.triggers["delete"] || trigger[1] == "1"
		meta.triggers["update"] = meta.triggers["update"] || trigger[2] == "1"
	}
	references, err := queryStrings(ctx, source, `SELECT confupdtype::text, confdeltype::text FROM pg_constraint
		WHERE confrelid = to_regclass($1) AND contype = 'f'`, reference)
	if err != nil {
		return err
	}
	for _, reference := range references {
		meta.cascades["update"] = meta.cascades["update"] || changesRows(reference[0])
		meta.cascades["delete"] = meta.cascades["delete"] || changesRows(reference[1])
	}
	return nil
}
