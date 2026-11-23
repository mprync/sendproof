package dbsql

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/mprync/sendproof/adapters/go/sendproof"
)

func (p *provider) BeginHeld(ctx context.Context) (sendproof.HeldSQL, error) {
	lifetime, cancel := context.WithCancel(context.WithoutCancel(ctx))
	stop := context.AfterFunc(ctx, cancel)
	s, err := p.db.openScope(ctx, true, lifetime)
	handedOff := stop()
	if err == nil && (!handedOff || ctx.Err() != nil) {
		err = errors.Join(ctx.Err(), s.close(context.WithoutCancel(ctx)))
	}
	if err != nil {
		cancel()
		if errors.Is(err, errLockTimeout) || p.db.dialect == DialectSQLite && sqliteLockError(err) {
			err = errors.Join(sendproof.ErrStoreBusy, err)
		}
		return nil, err
	}
	s.cancel = cancel
	held := &heldSQL{session: &session{scope: s}}
	if s.dialect == DialectSQLServer {
		if err := s.tx.QueryRowContext(ctx, "SELECT CURRENT_TRANSACTION_ID()").Scan(&held.transactionID); err != nil {
			return nil, errors.Join(err, held.Close())
		}
	}
	return held, nil
}

func sqliteLockError(err error) bool {
	var coded interface{ Code() int }
	if errors.As(err, &coded) {
		return coded.Code()&0xff == 5 || coded.Code()&0xff == 6 // SQLITE_BUSY or SQLITE_LOCKED
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "database is locked") || strings.Contains(message, "database table is locked")
}

type heldSQL struct {
	*session
	transactionID int64
}

func (h *heldSQL) Unwrap() sendproof.Session { return h.session }

func stepSavepoint(step int) string { return fmt.Sprintf("sendproof_step_%d", step) }

// A nested check savepoint can be released after a kept step without
// destroying its rewind boundary. SQL Server validates the transaction ID
// instead, since it has no RELEASE SAVEPOINT.
const stepCheck = "sendproof_step_check"

func (h *heldSQL) StartStep(ctx context.Context, step int) error {
	s := h.scope
	s.mu.Lock()
	defer s.mu.Unlock()
	h.resetCapture()
	create, release, _ := s.dialect.savepointSQL(stepSavepoint(step))
	if _, err := s.tx.ExecContext(ctx, create); err != nil {
		return h.storeError(err)
	}
	if release != "" {
		check, _, _ := s.dialect.savepointSQL(stepCheck)
		if _, err := s.tx.ExecContext(ctx, check); err != nil {
			return h.storeError(err)
		}
	}
	if s.dialect == DialectPostgres {
		// Keep prior writes in the transaction while showing only this step.
		// The rewind boundary also restores the audit table.
		_, err := s.tx.ExecContext(ctx, "DELETE FROM pg_temp.sendproof_audit")
		return h.storeError(err)
	}
	return nil
}

func (h *heldSQL) CaptureStep(ctx context.Context) error {
	s := h.scope
	s.mu.Lock()
	defer s.mu.Unlock()
	h.closeStatements()
	if s.dialect == DialectPostgres {
		// A query error may leave its statement savepoint pending. A held step
		// with a failed transaction must rewind, even if the handler caught it.
		if _, err := s.tx.ExecContext(ctx, "SELECT 1"); err != nil {
			return h.storeError(err)
		}
	}
	if s.depth != 0 {
		return errors.New("dbsql: the handler left a transaction open during the preview step")
	}
	changes, truncated, err := s.capturePreview(ctx)
	if err != nil {
		return h.storeError(err)
	}
	if s.dialect == DialectSQLServer {
		var id int64
		var state int
		if err := s.tx.QueryRowContext(ctx, "SELECT CURRENT_TRANSACTION_ID(), XACT_STATE()").Scan(&id, &state); err != nil {
			return h.storeError(err)
		}
		if id != h.transactionID || state != 1 {
			return errors.New("dbsql: the SQL Server transaction changed or cannot continue")
		}
	} else {
		_, release, _ := s.dialect.savepointSQL(stepCheck)
		if _, err := s.tx.ExecContext(ctx, release); err != nil {
			return h.storeError(err)
		}
	}
	h.mu.Lock()
	h.changes, h.truncated = changes, truncated
	h.mu.Unlock()
	return nil
}

func (h *heldSQL) Rewind(ctx context.Context, step int) error {
	s := h.scope
	s.mu.Lock()
	defer s.mu.Unlock()
	h.closeStatements()
	if err := s.failed(); err != nil {
		return h.storeError(err)
	}
	_, release, rollback := s.dialect.savepointSQL(stepSavepoint(step))
	if _, err := s.tx.ExecContext(ctx, rollback); err != nil {
		return h.storeError(err)
	}
	if release != "" {
		if _, err := s.tx.ExecContext(ctx, release); err != nil {
			return h.storeError(err)
		}
	}
	h.resetCapture()
	return nil
}

func (h *heldSQL) storeError(err error) error {
	if errors.Is(err, sql.ErrTxDone) {
		return errors.Join(sendproof.ErrSessionFailed, err)
	}
	return err
}

func (h *heldSQL) closeStatements() {
	for _, stmt := range h.scope.statements {
		_ = stmt.Close()
	}
	h.scope.statements = nil
}

func (h *heldSQL) resetCapture() {
	s := h.scope
	s.journal = journal{}
	if s.blind {
		s.journal.markIncomplete()
	}
	s.logContext, s.deferred, s.savepoints = nil, nil, nil
	s.pgStatement, s.depth = false, 0
	clear(s.warned)
}
