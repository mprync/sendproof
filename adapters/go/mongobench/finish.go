package mongobench

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/mprync/sendproof/adapters/go/sendproof"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// absentAtStart holds the server error codes meaning the collection or snapshot did
// not exist at the start time: NamespaceNotFound and SnapshotUnavailable.
var absentAtStart = []int{26, 246}

// Finish runs after the handler: it captures the document changes, then aborts the
// transaction and ends the session. A capture read that fails for any reason but an
// already-aborted transaction fails the Preview with 500, after the abort. Nothing
// the Preview wrote is ever committed: no commitTransaction is sent for the session.
func (p *preview) Finish(ctx context.Context) error {
	if p.session == nil {
		return nil // guard mode: nothing to capture or abort
	}
	p.mu.Lock()
	used, finished := p.used, p.finished
	p.mu.Unlock()
	if finished {
		return nil // the time limit already aborted it and recorded the fault
	}
	var failure error
	if used {
		failure = p.capture(ctx)
		var server mongo.ServerError
		// A failed command inside a transaction makes the server abort it: nothing to capture.
		if errors.As(failure, &server) && server.HasErrorLabel("NoSuchTransaction") || isCode(failure, 251) {
			failure = nil
		}
	}
	p.end()
	return failure
}

func isCode(err error, code int) bool {
	var server mongo.ServerError
	return errors.As(err, &server) && server.HasErrorCode(code)
}

// atStart finds documents as they were when the Preview transaction started: a
// snapshot read at its start time, outside the transaction. The driver's own read
// options cannot set atClusterTime, so the read is a raw find command. Without a
// start time (no reply carried one) it reads the majority-committed view: nothing
// the Preview wrote is committed, so the only difference is a concurrent commit by
// another request.
func (p *preview) atStart(ctx context.Context, namespace, collection string, query, projection any) ([]bson.Raw, error) {
	readConcern := bson.D{{Key: "level", Value: "majority"}}
	p.mu.Lock()
	if p.startTime != nil {
		readConcern = bson.D{{Key: "level", Value: "snapshot"}, {Key: "atClusterTime", Value: *p.startTime}}
	}
	p.mu.Unlock()
	command := bson.D{{Key: "find", Value: collection}, {Key: "filter", Value: query}}
	if projection != nil {
		command = append(command, bson.E{Key: "projection", Value: projection})
	}
	command = append(command, bson.E{Key: "batchSize", Value: candidateLimit}, bson.E{Key: "limit", Value: candidateLimit},
		bson.E{Key: "singleBatch", Value: true}, bson.E{Key: "readConcern", Value: readConcern})
	var reply struct {
		Cursor struct {
			FirstBatch []bson.Raw `bson:"firstBatch"`
		} `bson:"cursor"`
	}
	err := p.store.client.Database(namespace).RunCommand(internal(ctx), command).Decode(&reply)
	var server mongo.ServerError
	if errors.As(err, &server) {
		for _, code := range absentAtStart {
			if server.HasErrorCode(code) {
				return nil, nil // created after the start time: nothing in it existed then
			}
		}
	}
	return reply.Cursor.FirstBatch, err
}

// capture compares each candidate's start-time and in-transaction versions and
// records the differences as changes.
func (p *preview) capture(ctx context.Context) error {
	client := p.store.client
	inTransaction := mongo.NewSessionContext(internal(ctx), p.session)
	p.mu.Lock()
	filters := append([]filter(nil), p.filters...)
	p.mu.Unlock()
	idOnly := bson.D{{Key: "_id", Value: 1}}
	for _, f := range filters {
		target := client.Database(f.namespace).Collection(f.collection)
		cursor, err := target.Find(inTransaction, f.query, options.Find().SetProjection(idOnly).SetLimit(candidateLimit))
		if err != nil {
			return err
		}
		var inside []bson.Raw
		if err := cursor.All(inTransaction, &inside); err != nil {
			return err
		}
		before, err := p.atStart(ctx, f.namespace, f.collection, f.query, idOnly)
		if err != nil {
			return err
		}
		p.mu.Lock()
		for _, document := range append(inside, before...) {
			p.addCandidate(candidate{namespace: f.namespace, collection: f.collection, id: document.Lookup("_id"), via: f.via})
		}
		p.mu.Unlock()
	}
	p.mu.Lock()
	order := append([]string(nil), p.order...)
	candidates := make(map[string]candidate, len(p.candidates))
	for key, value := range p.candidates {
		candidates[key] = value
	}
	p.mu.Unlock()
	for index, key := range order {
		if index >= candidateLimit {
			sendproof.TruncateChanges(ctx)
			break
		}
		c := candidates[key]
		query := bson.D{{Key: "_id", Value: c.id}}
		started, err := p.atStart(ctx, c.namespace, c.collection, query, nil)
		if err != nil {
			return err
		}
		var was, now bson.Raw
		if len(started) > 0 {
			was = started[0]
		}
		current, err := client.Database(c.namespace).Collection(c.collection).FindOne(inTransaction, query).Raw()
		if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
			return err
		}
		if err == nil {
			now = current
		}
		if was == nil && now == nil || sameDocument(was, now) {
			continue
		}
		change := sendproof.Change{
			Operation: "update", Store: system, Namespace: c.namespace, Table: c.collection,
			Key: json.RawMessage(extJSONValue("_id", c.id)),
		}
		if was != nil {
			change.Before = json.RawMessage(extJSON(was))
		}
		if now != nil {
			change.After = json.RawMessage(extJSON(now))
		}
		switch {
		case was == nil:
			change.Operation = "insert"
		case now == nil:
			change.Operation = "delete"
		}
		if change.Operation != "delete" {
			change.Via = c.via
		}
		sendproof.RecordChange(ctx, change)
	}
	return nil
}
