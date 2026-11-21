package dbsql

import (
	"context"
	"database/sql"
	"sync"

	"github.com/mprync/sendproof/adapters/go/sendproof"
)

// provider implements sendproof.Provider and sendproof.ObservingProvider.
type provider struct{ db *DB }

func (p *provider) Database() string { return p.db.cfg.label }

// System names the SQL engine for capabilities `database.system`.
func (p *provider) System() string { return p.db.dialect.System() }

// Begin opens the preview transaction on a dedicated connection and prepares the
// dialect's change capture inside it.
func (p *provider) Begin(ctx context.Context) (sendproof.Session, error) {
	s, err := p.db.open(ctx, true)
	if err != nil {
		return nil, err
	}
	return &session{scope: s}, nil
}

// Observe reserves a dedicated connection for an observed send and prepares
// capture of the writes the request commits on it.
func (p *provider) Observe(ctx context.Context) (sendproof.Observation, error) {
	s, err := p.db.open(ctx, false)
	if err != nil {
		return nil, err
	}
	return &observation{scope: s}, nil
}

// session is one preview transaction.
type session struct {
	scope *scope

	mu        sync.Mutex
	changes   []sendproof.Change
	truncated bool
}

// Rollback captures the changes, then discards them with the transaction.
func (s *session) Rollback(ctx context.Context) error {
	changes, truncated, err := s.scope.finishPreview(ctx)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.changes, s.truncated = changes, truncated
	return err
}

func (s *session) Changes() []sendproof.Change {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.changes
}

func (s *session) ChangesTruncated() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.truncated
}

// Close rolls back a transaction that Rollback did not complete and returns the
// connection to the pool.
func (s *session) Close() error { return s.scope.close(context.Background()) }

// observation captures the committed writes of one observed send.
type observation struct{ scope *scope }

func (o *observation) Finish(ctx context.Context) ([]sendproof.Change, bool, error) {
	return o.scope.finishObserved(ctx)
}

func (o *observation) Close() error { return o.scope.close(context.Background()) }

// rowSource is the part of *sql.DB, *sql.Conn and *sql.Tx that capture reads
// use. Capture reads bypass command recording on purpose: they never appear in
// the log.
type rowSource interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

// sessionUnwrapper lets a wrapping sendproof.Session, such as a test double,
// expose the dbsql session it decorates.
type sessionUnwrapper interface {
	Unwrap() sendproof.Session
}

// ownSession finds the dbsql session behind a preview session.
func ownSession(active sendproof.Session) (*session, bool) {
	for active != nil {
		if ours, ok := active.(*session); ok {
			return ours, true
		}
		wrapper, ok := active.(sessionUnwrapper)
		if !ok {
			return nil, false
		}
		active = wrapper.Unwrap()
	}
	return nil, false
}
