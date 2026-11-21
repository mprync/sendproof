package dbsql

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// PostgreSQL previews capture changes with an audit table and row triggers that
// exist only inside the preview transaction. Begin creates a temporary audit
// table and a trigger function in pg_temp, then an AFTER INSERT OR UPDATE OR
// DELETE row trigger on every table the role may instrument. Each row change,
// including changes made by the application's triggers and by foreign-key
// actions, appends its old and new row to the audit table in order. Rolling the
// transaction back removes the triggers, the function and the table: none of
// them is ever visible to another session.
//
// PostgreSQL fires triggers of the same kind in name order. The audit trigger's
// name starts with "!", so it records a row change before the application's own
// AFTER triggers make their further changes, keeping the audit in causal order.
//
// Creating a trigger takes a SHARE ROW EXCLUSIVE lock on its table until the
// preview ends. Reads are unaffected, but concurrent writes to the database's
// tables, and other previews, wait for the preview to finish. Begin gives up
// after the lock timeout and reports Preview as unavailable.
//
// A second temporary table carries a deferred constraint trigger that raises an
// error, so the preview transaction can never commit: any COMMIT fails and rolls
// back instead.

// auditLockTimeout bounds how long Begin waits for the table locks.
const auditLockTimeout = "5s"

var auditSetup = []string{
	`CREATE TEMPORARY TABLE testbench_audit (seq bigserial PRIMARY KEY, relid oid NOT NULL,
		operation text NOT NULL, old_row jsonb, new_row jsonb) ON COMMIT DROP`,
	`CREATE FUNCTION pg_temp.testbench_audit() RETURNS trigger LANGUAGE plpgsql AS $testbench$
	BEGIN
		IF TG_LEVEL = 'STATEMENT' THEN
			INSERT INTO pg_temp.testbench_audit (relid, operation) VALUES (TG_RELID, TG_OP);
		ELSE
			INSERT INTO pg_temp.testbench_audit (relid, operation, old_row, new_row) VALUES (TG_RELID, TG_OP,
				CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END,
				CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END);
		END IF;
		RETURN NULL;
	END $testbench$`,
	`CREATE TEMPORARY TABLE testbench_guard (id int) ON COMMIT DROP`,
	`CREATE FUNCTION pg_temp.testbench_refuse_commit() RETURNS trigger LANGUAGE plpgsql AS $testbench$
	BEGIN
		RAISE EXCEPTION 'Test Bench: a preview transaction must never commit';
	END $testbench$`,
	`CREATE CONSTRAINT TRIGGER testbench_refuse_commit AFTER INSERT ON pg_temp.testbench_guard
		DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pg_temp.testbench_refuse_commit()`,
	`INSERT INTO pg_temp.testbench_guard VALUES (1)`,
}

// auditTables selects the ordinary and partitioned tables to instrument:
// everything outside the system schemas and temporary schemas, except tables
// that belong to extensions. Partitions inherit their parent's trigger.
const auditTables = `FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
	WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
		AND n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\_%'
		AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')`

var auditInstall = `DO $testbench$
DECLARE target record;
BEGIN
	FOR target IN SELECT c.oid::regclass AS relation, c.relkind ` + auditTables + `
		AND has_table_privilege(c.oid, 'TRIGGER') ORDER BY c.oid
	LOOP
		EXECUTE format('CREATE TRIGGER "!testbench_audit" AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION pg_temp.testbench_audit()', target.relation);
		IF target.relkind = 'r' THEN
			EXECUTE format('CREATE TRIGGER "!testbench_audit_truncate" AFTER TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION pg_temp.testbench_audit()', target.relation);
		END IF;
	END LOOP;
END $testbench$`

// auditBlind counts tables the role can write but not instrument.
var auditBlind = `SELECT count(*) ` + auditTables + `
	AND NOT has_table_privilege(c.oid, 'TRIGGER')
	AND (has_table_privilege(c.oid, 'INSERT') OR has_table_privilege(c.oid, 'UPDATE') OR has_table_privilege(c.oid, 'DELETE'))`

// installAudit prepares the preview transaction. It reports how many writable
// tables could not be instrumented.
func installAudit(ctx context.Context, tx *sql.Tx) (blind int, err error) {
	for _, statement := range auditSetup {
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return 0, fmt.Errorf("dbsql: prepare the PostgreSQL audit: %w", err)
		}
	}
	var previous string
	if err := tx.QueryRowContext(ctx, `SELECT current_setting('lock_timeout')`).Scan(&previous); err != nil {
		return 0, err
	}
	if _, err := tx.ExecContext(ctx, `SELECT set_config('lock_timeout', '`+auditLockTimeout+`', true)`); err != nil {
		return 0, err
	}
	if _, err := tx.ExecContext(ctx, auditInstall); err != nil {
		if sqlState(err) == "55P03" { // lock_not_available
			return 0, fmt.Errorf("dbsql: another transaction holds a table lock: %w", errLockTimeout)
		}
		return 0, fmt.Errorf("dbsql: install the PostgreSQL audit triggers: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `SELECT set_config('lock_timeout', $1, true)`, previous); err != nil {
		return 0, err
	}
	if err := tx.QueryRowContext(ctx, auditBlind).Scan(&blind); err != nil {
		return 0, err
	}
	return blind, nil
}

var errLockTimeout = errors.New("the preview could not lock the tables in time")

// readAudit returns the audit rows in order, at most limit of them, and the
// tables they touched. Updates that left a row unchanged are skipped.
func readAudit(ctx context.Context, source rowSource, limit int) ([]rowEvent, bool, []string, error) {
	tables := map[int64]tableName{}
	rows, err := source.QueryContext(ctx, `SELECT c.oid::bigint, n.nspname, c.relname, n.nspname = current_schema()
		FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE c.oid IN (SELECT DISTINCT relid FROM pg_temp.testbench_audit)`)
	if err != nil {
		return nil, false, nil, err
	}
	for rows.Next() {
		var oid int64
		var schema, name string
		var current bool
		if err := rows.Scan(&oid, &schema, &name, &current); err != nil {
			rows.Close()
			return nil, false, nil, err
		}
		table := tableName{schema: schema, name: name}
		if current {
			table.schema = ""
		}
		tables[oid] = table
	}
	if err := closeRows(rows); err != nil {
		return nil, false, nil, err
	}

	keys := map[int64][]string{}
	rows, err = source.QueryContext(ctx, `SELECT i.indrelid::bigint, a.attname FROM pg_index i
		CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
		JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
		WHERE i.indisprimary AND i.indrelid IN (SELECT DISTINCT relid FROM pg_temp.testbench_audit)
		ORDER BY i.indrelid, k.ord`)
	if err != nil {
		return nil, false, nil, err
	}
	for rows.Next() {
		var oid int64
		var column string
		if err := rows.Scan(&oid, &column); err != nil {
			rows.Close()
			return nil, false, nil, err
		}
		keys[oid] = append(keys[oid], column)
	}
	if err := closeRows(rows); err != nil {
		return nil, false, nil, err
	}

	rows, err = source.QueryContext(ctx, `SELECT relid::bigint, operation, old_row::text, new_row::text
		FROM pg_temp.testbench_audit WHERE operation <> 'UPDATE' OR old_row IS DISTINCT FROM new_row
		ORDER BY seq LIMIT $1`, limit+1)
	if err != nil {
		return nil, false, nil, err
	}
	defer rows.Close()
	var events []rowEvent
	var problems []string
	truncated := false
	for rows.Next() {
		var relid int64
		var operation string
		var before, after sql.NullString
		if err := rows.Scan(&relid, &operation, &before, &after); err != nil {
			return nil, false, nil, err
		}
		if len(events) == limit {
			truncated = true
			break
		}
		table := tables[relid]
		if operation == "TRUNCATE" {
			truncated = true
			problems = append(problems, fmt.Sprintf("TRUNCATE on %s removed rows that are not listed", table))
			continue
		}
		event := rowEvent{table: table, operation: strings.ToLower(operation)}
		if event.before, err = decodeRow(before); err != nil {
			return nil, false, nil, err
		}
		if event.after, err = decodeRow(after); err != nil {
			return nil, false, nil, err
		}
		identity := event.before
		if event.operation == "insert" {
			identity = event.after
		}
		if columns := keys[relid]; len(columns) > 0 {
			event.key = make(map[string]any, len(columns))
			for _, column := range columns {
				event.key[column] = identity[column]
			}
		} else {
			problems = append(problems, fmt.Sprintf("table %s has no primary key, so its changes carry no key", table))
		}
		events = append(events, event)
	}
	return events, truncated, problems, rows.Err()
}

func closeRows(rows *sql.Rows) error {
	err := rows.Err()
	return errors.Join(err, rows.Close())
}

// decodeRow reads a to_jsonb row. Numbers keep their exact text.
func decodeRow(value sql.NullString) (map[string]any, error) {
	if !value.Valid {
		return nil, nil
	}
	decoder := json.NewDecoder(strings.NewReader(value.String))
	decoder.UseNumber()
	var row map[string]any
	if err := decoder.Decode(&row); err != nil {
		return nil, fmt.Errorf("dbsql: decode an audit row: %w", err)
	}
	return row, nil
}

// sqlState returns the SQLSTATE of a driver error when the driver exposes it, as
// pgx and lib/pq do.
func sqlState(err error) string {
	var coded interface{ SQLState() string }
	if errors.As(err, &coded) {
		return coded.SQLState()
	}
	return ""
}

// abortedTransaction reports PostgreSQL's in_failed_sql_transaction state.
func abortedTransaction(err error) bool {
	return sqlState(err) == "25P02" || err != nil && strings.Contains(err.Error(), "current transaction is aborted")
}
