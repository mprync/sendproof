package sendproof

import (
	"context"
	"errors"
	"time"
)

// ErrPreviewUnavailable is returned by a Provider that cannot offer a rollback
// preview for the current request. The transport answers with HTTP 503.
var ErrPreviewUnavailable = errors.New("sendproof: preview is unavailable")

// ErrNoPreviewSession is returned by data-access wrappers that are used during a
// preview by a handler that was not marked for preview. Wrappers fail closed so an
// unreviewed handler can never commit while a preview is running.
var ErrNoPreviewSession = errors.New("sendproof: the preview handler was not marked with Preview")

// Provider opens rollback-only sessions on the data layer an operation writes to.
// A Sendproof with no provider still offers the request editor and Send. A bench
// with more than one provider cannot tell which one owns a request, so it offers
// no previews.
type Provider interface {
	// Database returns a public label for the workbench, without connection
	// details such as hosts, paths or credentials. It may be empty.
	Database() string

	// Begin starts the transaction a preview runs in. The provider owns cleanup of
	// any resource it acquired before returning an error.
	Begin(ctx context.Context) (Session, error)
}

// ObservingProvider is an optional Provider extension that observes the row
// changes of an ordinary Send without owning its transaction.
type ObservingProvider interface {
	Provider

	// Observe starts change capture for one observed send.
	Observe(ctx context.Context) (Observation, error)
}

// Session is the transaction and change capture of one preview request.
type Session interface {
	// Rollback captures the changes the handler made, then discards them. A failure
	// prevents Sendproof from confirming the preview. Changes is read afterwards.
	Rollback(ctx context.Context) error

	// Changes returns the captured row changes. It is valid after Rollback.
	Changes() []Change

	// ChangesTruncated reports whether the provider omitted changes.
	ChangesTruncated() bool

	// Close releases the session. It is always called, also after a failed
	// Rollback, and must roll the transaction back if Rollback did not complete.
	Close() error
}

// Observation captures changes during an observed send.
type Observation interface {
	// Finish returns the changes made since the observation began.
	Finish(ctx context.Context) (changes []Change, truncated bool, err error)

	// Close releases the observation.
	Close() error
}

// Change describes one captured row change using JSON-serializable values.
type Change struct {
	// Operation is "insert", "update" or "delete".
	Operation string `json:"operation"`
	// Store is the store id ("mongodb", "redis", "dynamodb") for a non-SQL change,
	// and empty for the SQL database.
	Store string `json:"store,omitempty"`
	// Namespace is the database a non-SQL change belongs to.
	Namespace string `json:"namespace,omitempty"`
	// Table is the affected table, MongoDB collection or Redis key prefix.
	Table string `json:"table"`
	// Key identifies the row, for example {"id":"a"}. Composite keys have several
	// members. A document change uses {"_id": ...}.
	Key any `json:"key"`
	// Before holds the previous row values, or nil for an insert.
	Before any `json:"before"`
	// After holds the new row values, or nil for a delete.
	After any `json:"after"`
	// Via says how the change was made when the operation hides it: "upsert" or
	// "replace". It is empty for an ordinary insert, update or delete.
	Via string `json:"via,omitempty"`
}

// Principal is the authenticated identity of a request, resolved by the host.
type Principal struct {
	// Subject is a stable identifier of the signed-in user. It owns observed traces.
	Subject string
	// Name is the display name shown in the workbench.
	Name string
	// Role is an optional display label for the user's role.
	Role string
	// Scheme names the authentication context, for example "cookie". Traces belong
	// to one subject within one scheme.
	Scheme string
	// Issuer optionally names who vouched for the subject, such as an OpenID
	// Connect issuer URL, when one scheme accepts identities from several issuers.
	// Traces belong to one subject of one issuer.
	Issuer string
}

// SQLArg is one bound parameter of an executed command.
type SQLArg struct {
	// Name is the parameter name. It is empty for a positional parameter.
	Name string
	// Value is the bound value.
	Value any
}

// SQLCall describes one executed database command for the capture journal.
type SQLCall struct {
	// Text is the SQL text.
	Text string
	// Args are the bound parameters. Their values are redacted according to the
	// bench configuration and the secret-name rules.
	Args []SQLArg
	// Duration is how long the command took.
	Duration time.Duration
	// RowsAffected is the affected row count, or -1 when unknown, as for a query.
	RowsAffected int64
	// Category labels the data layer, for example "database/sql".
	Category string
	// Err is the command failure, if any.
	Err error
}
