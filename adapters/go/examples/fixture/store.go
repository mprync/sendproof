package fixture

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"strings"

	"github.com/go-sql-driver/mysql"
	_ "github.com/jackc/pgx/v5/stdlib"  // registers the "pgx" driver
	_ "github.com/microsoft/go-mssqldb" // registers the "sqlserver" driver
	gormmysql "gorm.io/driver/mysql"
	gormpostgres "gorm.io/driver/postgres"
	gormsqlite "gorm.io/driver/sqlite"
	gormsqlserver "gorm.io/driver/sqlserver"
	"gorm.io/gorm"
	gormlogger "gorm.io/gorm/logger"
	_ "modernc.org/sqlite" // registers the "sqlite" driver with the pre-update hook

	"github.com/mprync/sendproof/adapters/go/dbsql"
	gormsendproof "github.com/mprync/sendproof/adapters/go/gorm"
	"github.com/mprync/sendproof/adapters/go/sendproof"
)

// item is the fixture's single table row.
type item struct {
	ID   string `json:"id" gorm:"column:id;primaryKey"`
	Name string `json:"name" gorm:"column:name;not null"`
}

func (item) TableName() string { return "items" }

var errDuplicate = errors.New("the item already exists")

// Database selects the engine behind the fixture.
type Database struct {
	// Engine is "sqlite" (the default), "postgresql", "mysql" or "sqlserver".
	Engine string
	// URL is the connection URL of a fresh, empty database for server engines, in
	// the runner's format: postgresql://, mysql:// or mssql://.
	URL string
	// Directory holds the SQLite file. It defaults to a temporary directory.
	Directory string
}

// engine describes one database engine for the fixture.
type engine struct {
	driver      string
	createTable string
	// placeholder returns the bind marker for the 1-based position.
	placeholder func(int) string
	// secretQuery selects a bound parameter named fixture_secret.
	secretQuery string
	dialector   func(gorm.ConnPool) gorm.Dialector
}

var engines = map[string]engine{
	"sqlite": {
		driver:      "sqlite",
		createTable: `CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL)`,
		placeholder: func(int) string { return "?" },
		secretQuery: "SELECT @fixture_secret",
		dialector:   func(pool gorm.ConnPool) gorm.Dialector { return gormsqlite.Dialector{DriverName: "sqlite", Conn: pool} },
	},
	"postgresql": {
		driver:      "pgx",
		createTable: `CREATE TABLE items (id text PRIMARY KEY, name text NOT NULL)`,
		placeholder: func(position int) string { return fmt.Sprintf("$%d", position) },
		secretQuery: "SELECT $1::text",
		dialector:   func(pool gorm.ConnPool) gorm.Dialector { return gormpostgres.New(gormpostgres.Config{Conn: pool}) },
	},
	"mysql": {
		driver:      "mysql",
		createTable: "CREATE TABLE items (id VARCHAR(191) PRIMARY KEY, name VARCHAR(500) NOT NULL) ENGINE=InnoDB",
		placeholder: func(int) string { return "?" },
		secretQuery: "SELECT ?",
		dialector:   func(pool gorm.ConnPool) gorm.Dialector { return gormmysql.New(gormmysql.Config{Conn: pool}) },
	},
	"sqlserver": {
		driver:      "sqlserver",
		createTable: `CREATE TABLE items (id NVARCHAR(191) PRIMARY KEY, name NVARCHAR(500) NOT NULL)`,
		placeholder: func(position int) string { return fmt.Sprintf("@p%d", position) },
		secretQuery: "SELECT @fixture_secret",
		dialector:   func(pool gorm.ConnPool) gorm.Dialector { return gormsqlserver.New(gormsqlserver.Config{Conn: pool}) },
	},
}

// store hides whether the fixture uses database/sql directly or GORM.
type store interface {
	insert(ctx context.Context, id, name string) error
	get(ctx context.Context, id string) (item, bool, error)
	update(ctx context.Context, id, name string) (bool, error)
	remove(ctx context.Context, id string) error
	// bindSecret executes a statement with a secret-named bound parameter.
	bindSecret(ctx context.Context) error
	provider() sendproof.Provider
	close() error
}

// openStore connects to the configured database and creates the items table.
func openStore(kind string, database Database) (store, error) {
	name := database.Engine
	if name == "" {
		name = "sqlite"
	}
	spec, known := engines[name]
	if !known {
		return nil, fmt.Errorf("unknown database %q", database.Engine)
	}
	dsn, err := dataSource(name, database)
	if err != nil {
		return nil, err
	}
	pool, err := sql.Open(spec.driver, dsn)
	if err != nil {
		return nil, err
	}
	if name != "sqlite" {
		// A bounded pool that keeps its connections, as a production service configures it. database/sql keeps only two
		// idle connections by default, so concurrent requests would otherwise reconnect almost every time.
		pool.SetMaxOpenConns(24)
		pool.SetMaxIdleConns(24)
	}
	if _, err := pool.Exec(spec.createTable); err != nil {
		return nil, errors.Join(err, pool.Close())
	}
	db, err := dbsql.Wrap(pool, dbsql.WithDatabaseLabel("conformance"))
	if err != nil {
		return nil, errors.Join(err, pool.Close())
	}
	base := sqlStore{db: db, pool: pool, spec: spec}
	switch kind {
	case "", "sql":
		return &base, nil
	case "gorm":
		gdb, err := gorm.Open(spec.dialector(gormsendproof.NewPool(db)), &gorm.Config{Logger: gormlogger.Discard})
		if err != nil {
			return nil, errors.Join(err, pool.Close())
		}
		return &gormStore{sqlStore: base, gdb: gdb}, nil
	}
	return nil, errors.Join(fmt.Errorf("unknown store %q", kind), pool.Close())
}

// DataSource returns the database/sql driver name and data source name for a
// database. The SQLite file is fixture.db in the database's directory.
func DataSource(database Database) (driver, dsn string, err error) {
	name := database.Engine
	if name == "" {
		name = "sqlite"
	}
	spec, known := engines[name]
	if !known {
		return "", "", fmt.Errorf("unknown database %q", database.Engine)
	}
	dsn, err = dataSource(name, database)
	return spec.driver, dsn, err
}

// dataSource turns the runner's URL into the driver's data source name.
func dataSource(engine string, database Database) (string, error) {
	if engine == "sqlite" {
		path := filepath.Join(database.Directory, "fixture.db")
		return "file:" + path + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)", nil
	}
	if database.URL == "" {
		return "", fmt.Errorf("BENCH_DATABASE_URL is required for %s", engine)
	}
	parsed, err := url.Parse(database.URL)
	if err != nil {
		return "", fmt.Errorf("invalid database URL: %w", err)
	}
	password, _ := parsed.User.Password()
	name := strings.TrimPrefix(parsed.Path, "/")
	switch engine {
	case "postgresql":
		return database.URL, nil
	case "mysql":
		config := mysql.NewConfig()
		config.User, config.Passwd, config.Net, config.Addr, config.DBName = parsed.User.Username(), password, "tcp", parsed.Host, name
		config.ParseTime = true
		config.ClientFoundRows = true // count matched rows, as the other engines do
		return config.FormatDSN(), nil
	case "sqlserver":
		query := url.Values{"database": {name}}
		if value := parsed.Query().Get("encrypt"); value != "" {
			query.Set("encrypt", value)
		}
		if value := parsed.Query().Get("trustServerCertificate"); value != "" {
			query.Set("TrustServerCertificate", value)
		}
		target := url.URL{Scheme: "sqlserver", User: parsed.User, Host: parsed.Host, RawQuery: query.Encode()}
		return target.String(), nil
	}
	return "", fmt.Errorf("unknown database %q", engine)
}

// isConflict recognizes a primary-key violation in each engine's wording.
func isConflict(err error) bool {
	if err == nil {
		return false
	}
	message := err.Error()
	for _, marker := range []string{"UNIQUE", "constraint", "duplicate key", "Duplicate entry", "Violation of PRIMARY KEY"} {
		if strings.Contains(message, marker) {
			return true
		}
	}
	return false
}

type sqlStore struct {
	db   *dbsql.DB
	pool *sql.DB
	spec engine
}

func (s *sqlStore) provider() sendproof.Provider { return s.db.Provider() }

func (s *sqlStore) close() error { return s.pool.Close() }

func (s *sqlStore) ph(position int) string { return s.spec.placeholder(position) }

func (s *sqlStore) insert(ctx context.Context, id, name string) error {
	_, err := s.db.ExecContext(ctx, "INSERT INTO items (id, name) VALUES ("+s.ph(1)+", "+s.ph(2)+")", id, name)
	if isConflict(err) {
		return errDuplicate
	}
	return err
}

func (s *sqlStore) get(ctx context.Context, id string) (item, bool, error) {
	var found item
	err := s.db.QueryRowContext(ctx, "SELECT id, name FROM items WHERE id = "+s.ph(1), id).Scan(&found.ID, &found.Name)
	if errors.Is(err, sql.ErrNoRows) {
		return item{}, false, nil
	}
	return found, err == nil, err
}

func (s *sqlStore) update(ctx context.Context, id, name string) (bool, error) {
	result, err := s.db.ExecContext(ctx, "UPDATE items SET name = "+s.ph(1)+" WHERE id = "+s.ph(2), name, id)
	if err != nil {
		return false, err
	}
	rows, err := result.RowsAffected()
	return rows > 0, err
}

func (s *sqlStore) remove(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM items WHERE id = "+s.ph(1), id)
	return err
}

// bindSecret binds a parameter named fixture_secret. Drivers without named
// parameters receive it positionally; dbsql still records and redacts it by name.
func (s *sqlStore) bindSecret(ctx context.Context) error {
	rows, err := s.db.QueryContext(ctx, s.spec.secretQuery, sql.Named("fixture_secret", "fixture-secret-value"))
	if err != nil {
		return err
	}
	return rows.Close()
}

type gormStore struct {
	sqlStore
	gdb *gorm.DB
}

func (s *gormStore) insert(ctx context.Context, id, name string) error {
	err := s.gdb.WithContext(ctx).Create(&item{ID: id, Name: name}).Error
	if isConflict(err) {
		return errDuplicate
	}
	return err
}

func (s *gormStore) get(ctx context.Context, id string) (item, bool, error) {
	var found item
	result := s.gdb.WithContext(ctx).Limit(1).Find(&found, "id = ?", id)
	return found, result.RowsAffected > 0, result.Error
}

func (s *gormStore) update(ctx context.Context, id, name string) (bool, error) {
	result := s.gdb.WithContext(ctx).Model(&item{}).Where("id = ?", id).Update("name", name)
	return result.RowsAffected > 0, result.Error
}

func (s *gormStore) remove(ctx context.Context, id string) error {
	return s.gdb.WithContext(ctx).Delete(&item{}, "id = ?", id).Error
}

// GORM expands named arguments into positional ones, so the secret statement goes
// through the wrapper directly (the embedded sqlStore) to keep its parameter
// name visible to redaction.
