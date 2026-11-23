package mongobench

import (
	"context"
	"errors"
	"sync/atomic"
	"time"

	"github.com/mprync/sendproof/adapters/go/sendproof"
	"github.com/mprync/sendproof/adapters/go/stores"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/event"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/x/mongo/driver"
)

// sensitive commands are marked security-sensitive by the command monitoring
// specification: never logged.
var sensitive = map[string]bool{
	"authenticate": true, "saslstart": true, "saslcontinue": true, "getnonce": true, "createuser": true,
	"updateuser": true, "copydbgetnonce": true, "copydbsaslstart": true, "copydb": true,
}

// envelope holds the fields the driver adds to every command; they carry no meaning
// for the log and are dropped from the statement.
var envelope = map[string]bool{
	"lsid": true, "txnNumber": true, "autocommit": true, "startTransaction": true, "$clusterTime": true,
	"$db": true, "$readPreference": true, "readConcern": true, "writeConcern": true, "apiVersion": true,
	"apiStrict": true, "apiDeprecationErrors": true,
}

// endsTransaction names the commands that end a transaction. In a Preview only the
// engine may send them.
func endsTransaction(lowerName string) bool {
	return lowerName == "committransaction" || lowerName == "aborttransaction"
}

// pendingCommand is a command seen by the monitor, kept until its reply arrives.
type pendingCommand struct {
	ctx       context.Context
	preview   *preview
	name      string
	namespace string
	target    string
	statement string
	command   bson.Raw
	started   time.Time
}

// monitor builds the command monitor. It chains the monitor the application
// already set, so installing the store never removes theirs.
func (s *Store) monitor(previous *event.CommandMonitor) *event.CommandMonitor {
	return &event.CommandMonitor{
		Started: func(ctx context.Context, e *event.CommandStartedEvent) {
			s.started(ctx, e)
			if previous != nil && previous.Started != nil {
				previous.Started(ctx, e)
			}
		},
		Succeeded: func(ctx context.Context, e *event.CommandSucceededEvent) {
			s.succeeded(ctx, e)
			if previous != nil && previous.Succeeded != nil {
				previous.Succeeded(ctx, e)
			}
		},
		Failed: func(ctx context.Context, e *event.CommandFailedEvent) {
			s.failed(ctx, e)
			if previous != nil && previous.Failed != nil {
				previous.Failed(ctx, e)
			}
		},
	}
}

// recovered keeps a panic in the monitor from reaching the application's own
// MongoDB call. During a Preview it fails the Preview, because the binding can no
// longer vouch for what the command did.
func (s *Store) recovered(ctx context.Context) {
	if recover() != nil {
		_ = sendproof.RefusePreview(ctx, "The MongoDB command monitor failed; the Preview can't be confirmed.")
	}
}

// previewOf returns this store's state for the Preview ctx belongs to, or nil.
func (s *Store) previewOf(ctx context.Context) *preview {
	state, _ := sendproof.PreviewStore(ctx, s).(*preview)
	return state
}

// started is the tripwire: it sees every command the client sends, in the context
// of the call that sent it.
func (s *Store) started(ctx context.Context, e *event.CommandStartedEvent) {
	defer s.recovered(ctx)
	if probe, _ := ctx.Value(probeKey{}).(*Store); probe == s {
		s.mu.Lock()
		s.monitored = true
		s.mu.Unlock()
	}
	if isInternal(ctx) {
		return
	}
	name := e.CommandName
	lowerName := lower(name)
	command := rawToDoc(e.Command)
	kind := stores.ClassifyMongo(command, s.reads).Kind
	inPreview := sendproof.IsPreview(ctx)
	state := s.previewOf(ctx)
	if state != nil && state.session != nil && commandSession(e.Command) == state.lsid {
		// From here on the server may hold the transaction until an abort reaches it.
		state.mu.Lock()
		state.sent = true
		state.mu.Unlock()
	}
	switch {
	case inPreview && endsTransaction(lowerName):
		// Sent around the guarded handles, for example through a raw client: it may
		// have committed the Preview transaction, so the Preview can never be confirmed.
		_ = sendproof.RefusePreview(ctx, "A MongoDB "+name+" reached the server during a Preview; the Preview can't be confirmed.")
	case inPreview && kind == stores.Write:
		s.watchWrite(ctx, state, e, lowerName)
	case kind == stores.Write:
		// A write with no Preview in its context, such as a guarded call made with
		// context.Background(), fails every open Preview unless it belongs to
		// another request or to work marked sendproof.Detached.
		sendproof.ReportWrite(ctx, system, name)
	}
	if kind == stores.Session || sensitive[lowerName] {
		return
	}
	target := ""
	if len(command) > 0 {
		if text, ok := command[0].Value.(string); ok {
			target = text
		}
	}
	var body stores.Doc
	for _, field := range command {
		if !envelope[field.Key] {
			body = append(body, field)
		}
	}
	s.mu.Lock()
	s.pending[e.RequestID] = &pendingCommand{
		ctx: ctx, preview: state, name: name, namespace: e.DatabaseName, target: target,
		statement: stores.SanitizeDocument(body), command: append(bson.Raw(nil), e.Command...), started: time.Now(),
	}
	s.mu.Unlock()
}

// watchWrite handles a write seen during a Preview: it collects change candidates,
// or trips when the write did not run in the Preview's transaction.
func (s *Store) watchWrite(ctx context.Context, state *preview, e *event.CommandStartedEvent, lowerName string) {
	lsid := commandSession(e.Command)
	autocommit, hasAutocommit := e.Command.Lookup("autocommit").BooleanOK()
	// Only a command inside the Preview transaction (its lsid and autocommit: false)
	// rolls back. The binding cannot undo anything else: never claim a rollback.
	if state == nil || state.session == nil || state.ended() || lsid != state.lsid || !hasAutocommit || autocommit {
		_ = sendproof.RefusePreview(ctx, "A MongoDB "+e.CommandName+" escaped the Preview session; the Preview can't be confirmed.")
		return
	}
	if state.held != nil && ctx.Value(heldCallKey{}) != state {
		_ = sendproof.RefusePreview(ctx, "A MongoDB write reached the Preview session without a before image.")
		return
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	state.used = true
	namespace := e.DatabaseName
	collection := ""
	if value, ok := e.Command.Index(0).Value().StringValueOK(); ok {
		collection = value
	}
	switch lowerName {
	case "insert":
		for _, document := range arrayDocuments(e.Command, "documents") {
			state.addCandidate(candidate{namespace: namespace, collection: collection, id: document.Lookup("_id")})
		}
	case "update":
		for _, update := range arrayDocuments(e.Command, "updates") {
			via := ""
			if upsert, _ := update.Lookup("upsert").BooleanOK(); upsert {
				via = "upsert"
			} else if replaces(update.Lookup("u")) {
				via = "replace"
			}
			state.filters = append(state.filters, filter{namespace: namespace, collection: collection, query: documentOrEmpty(update.Lookup("q")), via: via})
		}
	case "delete":
		for _, remove := range arrayDocuments(e.Command, "deletes") {
			state.filters = append(state.filters, filter{namespace: namespace, collection: collection, query: documentOrEmpty(remove.Lookup("q"))})
		}
	case "findandmodify":
		via := ""
		if upsert, _ := e.Command.Lookup("upsert").BooleanOK(); upsert {
			via = "upsert"
		} else if replaces(e.Command.Lookup("update")) {
			via = "replace"
		}
		state.filters = append(state.filters, filter{namespace: namespace, collection: collection, query: documentOrEmpty(e.Command.Lookup("query")), via: via})
	case "bulkwrite":
		// The client-level bulkWrite command: each op names its namespace by index.
		var namespaces []string
		for _, info := range arrayDocuments(e.Command, "nsInfo") {
			name, _ := info.Lookup("ns").StringValueOK()
			namespaces = append(namespaces, name)
		}
		for _, op := range arrayDocuments(e.Command, "ops") {
			var index int32 = -1
			for _, key := range []string{"insert", "update", "delete"} {
				if value, ok := op.Lookup(key).Int32OK(); ok {
					index = value
				}
			}
			database, target := namespace, ""
			if index >= 0 && int(index) < len(namespaces) {
				database, target = splitNamespace(namespaces[index], namespace)
			}
			if document, ok := op.Lookup("document").DocumentOK(); ok {
				state.addCandidate(candidate{namespace: database, collection: target, id: document.Lookup("_id")})
			} else {
				via := ""
				if upsert, _ := op.Lookup("upsert").BooleanOK(); upsert {
					via = "upsert"
				}
				state.filters = append(state.filters, filter{namespace: database, collection: target, query: documentOrEmpty(op.Lookup("filter")), via: via})
			}
		}
	}
}

// commandSession is the session id a command carries in its lsid, or "".
func commandSession(command bson.Raw) string {
	lsid := ""
	if value, err := command.LookupErr("lsid"); err == nil && value.Type == bson.TypeEmbeddedDocument {
		lsid, _ = sessionID(value.Document())
	}
	return lsid
}

// noSuchTransaction is the code of NoSuchTransaction: the server has no such
// transaction, so nothing holds its locks.
const noSuchTransaction = 251

// abortAnswered notes, on the engine's own abortTransaction, that the server
// answered it: acknowledged, or no such transaction. The driver hides that outcome.
func abortAnswered(ctx context.Context, name string, failure error) {
	acknowledged, _ := ctx.Value(abortKey{}).(*atomic.Bool)
	if acknowledged == nil || name != "abortTransaction" {
		return
	}
	// A network error proves nothing reached the server; only a server reply counts.
	if code, answered := replyCode(failure); failure == nil || answered && code == noSuchTransaction {
		acknowledged.Store(true)
	}
}

// replyCode is the server's error code in a command monitoring failure, and whether
// the server answered at all. Monitoring hands over the driver's own error type, not
// the mongo.CommandError a call returns.
func replyCode(failure error) (int32, bool) {
	var raw driver.Error
	if errors.As(failure, &raw) {
		return raw.Code, raw.Code != 0 && !raw.NetworkError()
	}
	var command mongo.CommandError
	if errors.As(failure, &command) {
		return command.Code, command.Code != 0 && !command.HasErrorLabel("NetworkError")
	}
	return 0, false
}

func splitNamespace(ns, fallback string) (database, collection string) {
	for index := 0; index < len(ns); index++ {
		if ns[index] == '.' {
			return ns[:index], ns[index+1:]
		}
	}
	return fallback, ns
}

// arrayDocuments returns the documents of the array member name of a command.
func arrayDocuments(command bson.Raw, name string) []bson.Raw {
	array, ok := command.Lookup(name).ArrayOK()
	if !ok {
		return nil
	}
	values, err := array.Values()
	if err != nil {
		return nil
	}
	documents := make([]bson.Raw, 0, len(values))
	for _, value := range values {
		if document, ok := value.DocumentOK(); ok {
			documents = append(documents, append(bson.Raw(nil), document...))
		}
	}
	return documents
}

// documentOrEmpty returns a value as a document, or an empty one.
func documentOrEmpty(value bson.RawValue) bson.Raw {
	if document, ok := value.DocumentOK(); ok {
		return append(bson.Raw(nil), document...)
	}
	return bson.Raw{}
}

// replaces reports whether an update document replaces the whole document rather
// than applying operators or a pipeline.
func replaces(update bson.RawValue) bool {
	document, ok := update.DocumentOK()
	if !ok {
		return false
	}
	elements, err := document.Elements()
	return err == nil && len(elements) > 0 && len(elements[0].Key()) > 0 && elements[0].Key()[0] != '$'
}

// addCandidate remembers one document the Preview may have changed. The caller holds state.mu.
func (p *preview) addCandidate(c candidate) {
	if c.id.Type == 0 {
		return
	}
	key := c.namespace + "\x00" + c.collection + "\x00" + string(extJSONValue("_id", c.id))
	known, seen := p.candidates[key]
	if !seen {
		p.order = append(p.order, key)
	}
	if !seen || known.via == "" && c.via != "" {
		p.candidates[key] = c
	}
}

func (s *Store) take(requestID int64) *pendingCommand {
	s.mu.Lock()
	defer s.mu.Unlock()
	pending := s.pending[requestID]
	delete(s.pending, requestID)
	return pending
}

func (s *Store) succeeded(ctx context.Context, e *event.CommandSucceededEvent) {
	defer s.recovered(ctx)
	abortAnswered(ctx, e.CommandName, nil)
	pending := s.take(e.RequestID)
	if pending == nil {
		return
	}
	state := pending.preview
	if state != nil && state.session != nil {
		state.noteReply(pending, e.Reply)
	}
	rows := sendproof.UnknownRows
	if cursor, ok := e.Reply.Lookup("cursor").DocumentOK(); ok {
		for _, batch := range []string{"firstBatch", "nextBatch"} {
			if array, ok := cursor.Lookup(batch).ArrayOK(); ok {
				if values, err := array.Values(); err == nil {
					rows = int64(len(values))
					break
				}
			}
		}
	} else if n, ok := e.Reply.Lookup("n").AsInt64OK(); ok {
		rows = n
	}
	s.log(pending, e.Duration, rows, "")
}

// noteReply records what the reply of a Preview command tells the change capture:
// the transaction's snapshot time, upserted ids and findAndModify results.
func (p *preview) noteReply(pending *pendingCommand, reply bson.Raw) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.held != nil && commandSession(pending.command) == p.lsid && len(arrayDocuments(reply, "writeErrors")) != 0 {
		p.heldFailed = true
	}
	if p.startTime == nil {
		if lsidValue, err := pending.command.LookupErr("lsid"); err == nil && lsidValue.Type == bson.TypeEmbeddedDocument {
			if lsid, _ := sessionID(lsidValue.Document()); lsid == p.lsid {
				// The first reply in the transaction carries its snapshot time.
				if t, i, ok := reply.Lookup("operationTime").TimestampOK(); ok {
					p.startTime = &bson.Timestamp{T: t, I: i}
				}
			}
		}
	}
	if pending.target == "" {
		return
	}
	for _, document := range arrayDocuments(reply, "upserted") {
		p.addCandidate(candidate{namespace: pending.namespace, collection: pending.target, id: document.Lookup("_id"), via: "upsert"})
	}
	if lower(pending.name) == "findandmodify" {
		if value, ok := reply.Lookup("value").DocumentOK(); ok {
			p.addCandidate(candidate{namespace: pending.namespace, collection: pending.target, id: value.Lookup("_id")})
		}
		if info, ok := reply.Lookup("lastErrorObject").DocumentOK(); ok && info.Lookup("upserted").Type != 0 {
			p.addCandidate(candidate{namespace: pending.namespace, collection: pending.target, id: info.Lookup("upserted"), via: "upsert"})
		}
	}
}

func (s *Store) failed(ctx context.Context, e *event.CommandFailedEvent) {
	defer s.recovered(ctx)
	abortAnswered(ctx, e.CommandName, e.Failure)
	pending := s.take(e.RequestID)
	if pending == nil {
		return
	}
	// The server refused something a transaction cannot do and applied nothing: a
	// block, not a crash.
	if code, answered := replyCode(e.Failure); pending.preview != nil && answered && code == 263 {
		sendproof.BlockPreview(pending.ctx, system, pending.name, refusedReason(pending.name))
	}
	if code, answered := replyCode(e.Failure); pending.preview != nil && pending.preview.held != nil && answered && code == noSuchTransaction {
		pending.preview.mu.Lock()
		pending.preview.heldFailed = true
		pending.preview.mu.Unlock()
	}
	s.log(pending, e.Duration, sendproof.UnknownRows, errorName(e.Failure))
}

// errorName is the server's error code name, such as WriteConflict.
func errorName(err error) string {
	// Monitoring hands over the driver's own error type.
	var raw driver.Error
	if errors.As(err, &raw) && raw.Name != "" {
		return raw.Name
	}
	var command mongo.CommandError
	if errors.As(err, &command) && command.Name != "" {
		return command.Name
	}
	var write mongo.WriteException
	if errors.As(err, &write) && len(write.WriteErrors) > 0 && write.WriteErrors[0].Code != 0 {
		return "WriteError"
	}
	return "Error"
}

func (s *Store) log(pending *pendingCommand, duration time.Duration, rows int64, failure string) {
	sendproof.RecordDb(pending.ctx, sendproof.DbCall{
		System: system, Operation: pending.name, Namespace: pending.namespace, Target: pending.target,
		Statement: pending.statement, RowsAffected: rows, Duration: duration, Error: failure,
	})
}
