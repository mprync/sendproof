package dbsql

import (
	"database/sql"
	"fmt"
	"reflect"
	"strconv"
	"strings"
)

// Dialect names the database engine behind a pool. It selects the change-capture
// mechanism and the SQL the provider issues.
type Dialect int

const (
	// DialectAuto detects the engine from the registered database/sql driver.
	DialectAuto Dialect = iota
	// DialectSQLite captures changes with SQLite's pre-update hook. The driver
	// must expose RegisterPreUpdateHook, RegisterCommitHook and RegisterRollbackHook
	// on its connection, as modernc.org/sqlite does.
	DialectSQLite
	// DialectPostgres captures preview changes with audit triggers created inside
	// the rolled-back transaction, and observed sends with primary-key reads.
	DialectPostgres
	// DialectMySQL captures changes with primary-key-scoped reads around each
	// statement. It suits MySQL 8 and MariaDB with InnoDB tables.
	DialectMySQL
	// DialectSQLServer captures changes with primary-key-scoped reads around each
	// statement, using OUTPUT to identify generated keys.
	DialectSQLServer
)

// String returns the dialect's display name.
func (d Dialect) String() string {
	switch d {
	case DialectSQLite:
		return "SQLite"
	case DialectPostgres:
		return "PostgreSQL"
	case DialectMySQL:
		return "MySQL"
	case DialectSQLServer:
		return "SQL Server"
	}
	return "auto"
}

// driverDialects maps driver package paths to their dialect.
var driverDialects = []struct {
	prefix  string
	dialect Dialect
}{
	{"modernc.org/sqlite", DialectSQLite},
	{"github.com/mattn/go-sqlite3", DialectSQLite},
	{"github.com/glebarez/go-sqlite", DialectSQLite},
	{"github.com/ncruces/go-sqlite3", DialectSQLite},
	{"github.com/jackc/pgx", DialectPostgres},
	{"github.com/lib/pq", DialectPostgres},
	{"github.com/go-sql-driver/mysql", DialectMySQL},
	{"github.com/microsoft/go-mssqldb", DialectSQLServer},
	{"github.com/denisenkom/go-mssqldb", DialectSQLServer},
}

// detectDialect identifies the engine from the type of the pool's driver.
func detectDialect(pool *sql.DB) (Dialect, error) {
	kind := reflect.TypeOf(pool.Driver())
	for kind != nil && kind.Kind() == reflect.Pointer {
		kind = kind.Elem()
	}
	path := ""
	if kind != nil {
		path = kind.PkgPath()
	}
	for _, known := range driverDialects {
		if strings.HasPrefix(path, known.prefix) {
			return known.dialect, nil
		}
	}
	return DialectAuto, fmt.Errorf("dbsql: cannot tell the database engine of driver %q; pass WithDialect", path)
}

// quoteIdent quotes one identifier for the dialect.
func (d Dialect) quoteIdent(name string) string {
	switch d {
	case DialectMySQL:
		return "`" + strings.ReplaceAll(name, "`", "``") + "`"
	case DialectSQLServer:
		return "[" + strings.ReplaceAll(name, "]", "]]") + "]"
	}
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}

// quoteTable quotes a table name with an optional schema.
func (d Dialect) quoteTable(table tableName) string {
	if table.schema == "" {
		return d.quoteIdent(table.name)
	}
	return d.quoteIdent(table.schema) + "." + d.quoteIdent(table.name)
}

// placeholder returns the bind placeholder for the 1-based position.
func (d Dialect) placeholder(position int) string {
	switch d {
	case DialectPostgres:
		return "$" + strconv.Itoa(position)
	case DialectSQLServer:
		return "@p" + strconv.Itoa(position)
	}
	return "?"
}

// savepointSQL returns the statements that create, release and roll back to a
// savepoint. SQL Server has no release; its savepoints end with the transaction.
func (d Dialect) savepointSQL(name string) (create, release, rollback string) {
	if d == DialectSQLServer {
		return "SAVE TRANSACTION " + name, "", "ROLLBACK TRANSACTION " + name
	}
	return "SAVEPOINT " + name, "RELEASE SAVEPOINT " + name, "ROLLBACK TO SAVEPOINT " + name
}

// namedArgs reports whether the driver accepts sql.NamedArg values. Drivers that
// do not receive named arguments positionally; the name still drives redaction.
func (d Dialect) namedArgs() bool { return d == DialectSQLite || d == DialectSQLServer }

// tableName is a table reference with an optional schema or attached database.
type tableName struct {
	schema, name string
}

// String returns the name the workbench shows.
func (t tableName) String() string {
	if t.schema == "" {
		return t.name
	}
	return t.schema + "." + t.name
}
