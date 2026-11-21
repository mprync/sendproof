package dbsql

import (
	"context"
	"fmt"
	"reflect"
	"strconv"
)

// SQLite change capture uses the pre-update hook, which SQLite calls for every
// row an INSERT, UPDATE or DELETE changes on one connection, including rows
// changed by triggers, foreign-key actions and REPLACE conflict resolution. The
// provider registers it only on the connection a previewed or observed request
// runs on, so concurrent writers on other connections never appear, and the
// commit and rollback hooks tell which events were really kept.
//
// The hook methods are bound by reflection so the core module needs no SQLite
// dependency. modernc.org/sqlite (v1.29 or later) exposes them on its driver
// connection: RegisterPreUpdateHook(func(SQLitePreUpdateData)),
// RegisterCommitHook(func() int32) and RegisterRollbackHook(func()).

// SQLite operation codes passed to the pre-update hook.
const (
	sqliteDelete = 9
	sqliteInsert = 18
	sqliteUpdate = 23
)

// sqliteHooks are the hook registration methods of one driver connection.
type sqliteHooks struct {
	preUpdate, commit, rollback reflect.Value
	data                        reflect.Type // the driver's pre-update data struct
}

// bindSQLiteHooks finds and checks the hook methods of a driver connection.
func bindSQLiteHooks(driverConn any) (*sqliteHooks, error) {
	value := reflect.ValueOf(driverConn)
	hooks := &sqliteHooks{
		preUpdate: value.MethodByName("RegisterPreUpdateHook"),
		commit:    value.MethodByName("RegisterCommitHook"),
		rollback:  value.MethodByName("RegisterRollbackHook"),
	}
	unsupported := fmt.Errorf("dbsql: the SQLite driver %T has no pre-update, commit and rollback hooks; use modernc.org/sqlite", driverConn)
	if !hooks.preUpdate.IsValid() || !hooks.commit.IsValid() || !hooks.rollback.IsValid() {
		return nil, unsupported
	}
	callbackShape := func(method reflect.Value, in, out int) (reflect.Type, bool) {
		kind := method.Type()
		if kind.NumIn() != 1 || kind.NumOut() != 0 || kind.In(0).Kind() != reflect.Func {
			return nil, false
		}
		callback := kind.In(0)
		return callback, callback.NumIn() == in && callback.NumOut() == out
	}
	preUpdate, ok := callbackShape(hooks.preUpdate, 1, 0)
	if !ok || preUpdate.In(0).Kind() != reflect.Struct {
		return nil, unsupported
	}
	if commit, ok := callbackShape(hooks.commit, 0, 1); !ok || commit.Out(0).Kind() != reflect.Int32 {
		return nil, unsupported
	}
	if _, ok := callbackShape(hooks.rollback, 0, 0); !ok {
		return nil, unsupported
	}
	hooks.data = preUpdate.In(0)
	pointer := reflect.PointerTo(hooks.data)
	for _, field := range []string{"Op", "DatabaseName", "TableName", "OldRowID", "NewRowID"} {
		if _, found := hooks.data.FieldByName(field); !found {
			return nil, unsupported
		}
	}
	for _, method := range []string{"Count", "Old", "New"} {
		if _, found := pointer.MethodByName(method); !found {
			return nil, unsupported
		}
	}
	return hooks, nil
}

// sqliteRow is one call of the pre-update hook, copied out of the driver.
type sqliteRow struct {
	operation     int64
	schema, table string
	oldID, newID  int64
	before, after []any
	readFailure   error
}

// register installs the three callbacks. Nil callbacks remove the hooks.
func (h *sqliteHooks) register(preUpdate func(sqliteRow), commit func() int32, rollback func()) {
	if preUpdate == nil {
		h.preUpdate.Call([]reflect.Value{reflect.Zero(h.preUpdate.Type().In(0))})
		h.commit.Call([]reflect.Value{reflect.Zero(h.commit.Type().In(0))})
		h.rollback.Call([]reflect.Value{reflect.Zero(h.rollback.Type().In(0))})
		return
	}
	data := h.data
	h.preUpdate.Call([]reflect.Value{reflect.MakeFunc(h.preUpdate.Type().In(0), func(args []reflect.Value) []reflect.Value {
		pointer := reflect.New(data)
		pointer.Elem().Set(args[0])
		preUpdate(readSQLiteRow(pointer))
		return nil
	})})
	h.commit.Call([]reflect.Value{reflect.MakeFunc(h.commit.Type().In(0), func([]reflect.Value) []reflect.Value {
		return []reflect.Value{reflect.ValueOf(commit()).Convert(h.commit.Type().In(0).Out(0))}
	})})
	h.rollback.Call([]reflect.Value{reflect.MakeFunc(h.rollback.Type().In(0), func([]reflect.Value) []reflect.Value {
		rollback()
		return nil
	})})
}

// readSQLiteRow copies the operation, table and old and new column values. It
// runs inside the hook, before SQLite applies the change.
func readSQLiteRow(pointer reflect.Value) (row sqliteRow) {
	defer func() {
		if failure := recover(); failure != nil {
			row.readFailure = fmt.Errorf("dbsql: reading the SQLite pre-update row failed: %v", failure)
		}
	}()
	data := pointer.Elem()
	row = sqliteRow{
		operation: data.FieldByName("Op").Int(),
		schema:    data.FieldByName("DatabaseName").String(),
		table:     data.FieldByName("TableName").String(),
		oldID:     data.FieldByName("OldRowID").Int(),
		newID:     data.FieldByName("NewRowID").Int(),
	}
	count := int(pointer.MethodByName("Count").Call(nil)[0].Int())
	read := func(method string) []any {
		values := make([]any, count)
		result := pointer.MethodByName(method).CallSlice([]reflect.Value{reflect.ValueOf(values)})
		if err, _ := result[0].Interface().(error); err != nil && row.readFailure == nil {
			row.readFailure = err
		}
		return values
	}
	if row.operation != sqliteInsert {
		row.before = read("Old")
	}
	if row.operation != sqliteDelete {
		row.after = read("New")
	}
	return row
}

// event converts a hook row into a journal event with positional values.
func (r sqliteRow) event() rowEvent {
	table := tableName{name: r.table}
	if r.schema != "" && r.schema != "main" {
		table.schema = r.schema
	}
	event := rowEvent{table: table, rawBefore: r.before, rawAfter: r.after, rowid: r.newID}
	switch r.operation {
	case sqliteInsert:
		event.operation = "insert"
	case sqliteDelete:
		event.operation, event.rowid = "delete", r.oldID
	default:
		event.operation, event.rowid = "update", r.oldID
	}
	return event
}

// sqliteColumns describes the columns of one table for naming hook values.
type sqliteColumns struct {
	all, stored []string // stored excludes virtual generated columns
	key         []string
}

// resolveSQLite names the positional values of hook events and sets their keys,
// reading each table's columns once with pragma_table_xinfo on source. Tables
// without a declared primary key are keyed by rowid, which identifies the row
// exactly.
func resolveSQLite(ctx context.Context, source rowSource, events []rowEvent) ([]rowEvent, error) {
	tables := map[tableName]*sqliteColumns{}
	for index := range events {
		event := &events[index]
		if event.rawBefore == nil && event.rawAfter == nil {
			continue
		}
		columns, known := tables[event.table]
		if !known {
			var err error
			if columns, err = readSQLiteColumns(ctx, source, event.table); err != nil {
				return nil, err
			}
			tables[event.table] = columns
		}
		event.before = nameValues(columns, event.rawBefore)
		event.after = nameValues(columns, event.rawAfter)
		identity := event.before
		if event.operation == "insert" {
			identity = event.after
		}
		if len(columns.key) == 0 {
			event.key = map[string]any{"rowid": event.rowid}
		} else {
			event.key = make(map[string]any, len(columns.key))
			for _, column := range columns.key {
				event.key[column] = identity[column]
			}
		}
		event.rawBefore, event.rawAfter = nil, nil
	}
	return events, nil
}

func readSQLiteColumns(ctx context.Context, source rowSource, table tableName) (*sqliteColumns, error) {
	schema := table.schema
	if schema == "" {
		schema = "main"
	}
	rows, err := source.QueryContext(ctx, "SELECT name, pk, hidden FROM pragma_table_xinfo(?, ?) ORDER BY cid", table.name, schema)
	if err != nil {
		return nil, fmt.Errorf("dbsql: read the columns of %s: %w", table, err)
	}
	defer rows.Close()
	columns := &sqliteColumns{}
	keys := map[int64]string{}
	for rows.Next() {
		var name string
		var pk, hidden int64
		if err := rows.Scan(&name, &pk, &hidden); err != nil {
			return nil, err
		}
		columns.all = append(columns.all, name)
		if hidden != 2 {
			columns.stored = append(columns.stored, name)
		}
		if pk > 0 {
			keys[pk] = name
		}
	}
	for position := int64(1); position <= int64(len(keys)); position++ {
		columns.key = append(columns.key, keys[position])
	}
	return columns, rows.Err()
}

// nameValues pairs positional values with column names. When the table changed
// shape during the request the values keep positional names.
func nameValues(columns *sqliteColumns, values []any) map[string]any {
	if values == nil {
		return nil
	}
	names := columns.all
	if len(values) != len(names) && len(values) == len(columns.stored) {
		names = columns.stored
	}
	named := make(map[string]any, len(values))
	for index, value := range values {
		name := "column" + strconv.Itoa(index+1)
		if len(values) == len(names) {
			name = names[index]
		}
		named[name] = value
	}
	return named
}
