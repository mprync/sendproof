package dbsql

import (
	"fmt"

	"github.com/mprync/sendproof/adapters/go/sendproof"
)

// Option configures Wrap.
type Option func(*config) error

type config struct {
	label   string
	dialect Dialect
	// safeProcedures are the MySQL procedures a preview may CALL.
	safeProcedures map[string]bool
}

// WithSafeProcedures declares MySQL and MariaDB stored procedures that never
// commit, by exact name ("name" or "schema.name", optionally backtick-quoted, no
// wildcards). The match ignores case, as MySQL routine names do, and a
// schema-qualified call matches only a declaration with that schema. During a
// preview every other CALL is refused, because a procedure can run COMMIT or an
// implicitly committing statement inside the preview transaction.
//
// Warning: declaring a procedure is your statement that it never commits. One
// that does would commit the handler's writes; the preview still fails, because
// the savepoint it set when it started is gone, but the writes stay.
func WithSafeProcedures(names ...string) Option {
	return func(c *config) error {
		set, err := safeProcedureSet(names)
		if err != nil {
			return err
		}
		if c.safeProcedures == nil {
			c.safeProcedures = map[string]bool{}
		}
		for name := range set {
			c.safeProcedures[name] = true
		}
		return nil
	}
}

// WithDatabaseLabel sets the database name shown in the workbench. Use a public
// label, never a connection string, host or file path: a label with a URL
// scheme, user information, path separators, key=value pairs or control
// characters is rejected.
func WithDatabaseLabel(label string) Option {
	return func(c *config) error {
		if !sendproof.IsDisplayLabel(label) {
			return fmt.Errorf("dbsql: the database label %q looks like connection details; use a bare name", label)
		}
		c.label = label
		return nil
	}
}

// WithDialect names the database engine when it cannot be detected from the
// driver, for example behind a custom or instrumented driver.
func WithDialect(dialect Dialect) Option {
	return func(c *config) error {
		if dialect < DialectAuto || dialect > DialectSQLServer {
			return fmt.Errorf("dbsql: unknown dialect %d", dialect)
		}
		c.dialect = dialect
		return nil
	}
}
