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
