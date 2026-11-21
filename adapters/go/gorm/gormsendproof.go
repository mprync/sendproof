// Package gormsendproof connects GORM to Sendproof through the dbsql provider.
//
// Build the GORM dialector on the pool returned by NewPool, so that every
// statement GORM runs flows through dbsql: it joins the preview transaction, and
// dbsql captures its row changes with the dialect's mechanism, exactly as for
// hand-written SQL. No model registration is needed. Pass
// db.WithContext(r.Context()) in handlers: GORM carries the request context into
// the pool only through WithContext.
//
//	sqlDB, _ := sql.Open("sqlite", dsn) // modernc.org/sqlite
//	wrapped, _ := dbsql.Wrap(sqlDB, dbsql.WithDatabaseLabel("app"))
//	gdb, _ := gorm.Open(sqlite.Dialector{Conn: gormsendproof.NewPool(wrapped)}, &gorm.Config{})
//	bench, _ := sendproof.New(sendproof.WithProvider(wrapped.Provider()))
//
// The same applies to the PostgreSQL, MySQL and SQL Server dialectors, which
// accept the pool as their Conn. GORM's nested transactions run on savepoints
// that dbsql follows, so a rolled-back SavePoint discards its captured changes.
package gormsendproof

import (
	"context"
	"database/sql"

	"gorm.io/gorm"

	"github.com/mprync/sendproof/adapters/go/dbsql"
)

// Pool adapts a dbsql.DB to GORM's connection-pool interfaces.
type Pool struct{ db *dbsql.DB }

var (
	_ gorm.ConnPool         = (*Pool)(nil)
	_ gorm.ConnPoolBeginner = (*Pool)(nil)
	_ gorm.GetDBConnector   = (*Pool)(nil)
	_ gorm.ConnPool         = (*txPool)(nil)
	_ gorm.TxCommitter      = (*txPool)(nil)
)

// NewPool returns the connection pool to hand to a GORM dialector.
func NewPool(db *dbsql.DB) *Pool { return &Pool{db: db} }

// PrepareContext implements gorm.ConnPool.
func (p *Pool) PrepareContext(ctx context.Context, query string) (*sql.Stmt, error) {
	return p.db.PrepareContext(ctx, query)
}

// ExecContext implements gorm.ConnPool.
func (p *Pool) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	return p.db.ExecContext(ctx, query, args...)
}

// QueryContext implements gorm.ConnPool.
func (p *Pool) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	return p.db.QueryContext(ctx, query, args...)
}

// QueryRowContext implements gorm.ConnPool.
func (p *Pool) QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row {
	return p.db.QueryRowContext(ctx, query, args...)
}

// BeginTx implements gorm.ConnPoolBeginner. During a preview the transaction is a savepoint.
func (p *Pool) BeginTx(ctx context.Context, options *sql.TxOptions) (gorm.ConnPool, error) {
	tx, err := p.db.BeginTx(ctx, options)
	if err != nil {
		return nil, err
	}
	return &txPool{tx: tx}, nil
}

// GetDBConn implements gorm.GetDBConnector so db.DB() keeps working.
func (p *Pool) GetDBConn() (*sql.DB, error) { return p.db.Unwrap(), nil }

// txPool is a transaction as a GORM connection pool.
type txPool struct{ tx *dbsql.Tx }

func (t *txPool) PrepareContext(ctx context.Context, query string) (*sql.Stmt, error) {
	return t.tx.PrepareContext(ctx, query)
}

func (t *txPool) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	return t.tx.ExecContext(ctx, query, args...)
}

func (t *txPool) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	return t.tx.QueryContext(ctx, query, args...)
}

func (t *txPool) QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row {
	return t.tx.QueryRowContext(ctx, query, args...)
}

func (t *txPool) Commit() error   { return t.tx.Commit() }
func (t *txPool) Rollback() error { return t.tx.Rollback() }
