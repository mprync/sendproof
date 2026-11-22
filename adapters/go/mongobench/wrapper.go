package mongobench

import (
	"context"

	"github.com/mprync/sendproof/adapters/go/sendproof"
	"github.com/mprync/sendproof/adapters/go/stores"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// The guarded handles have the driver's method set for the operations handlers use.
// A method the driver has that is not listed here does not exist on the handle, so
// it cannot be called unguarded by accident; reach the raw client only where the
// documented coverage limits are acceptable.

// systemDatabase reports whether commands on a database cannot join a transaction.
func systemDatabase(name string) bool {
	return name == "admin" || name == "config" || name == "local"
}

// command builds the one-key document the classifier reads for a driver method.
func command(name, collection string) stores.Doc {
	return stores.Doc{{Key: name, Value: collection}}
}

// noRelease is the release of a call that does not carry the Preview's session.
func noRelease() {}

// guardCall classifies a command before the driver builds it and returns the
// context to call the driver with, and a release the caller must call once the
// driver call returns. During a Preview in preview mode the Preview's session is
// added, so the command carries its lsid, txnNumber and autocommit: false; in
// guard mode every write is refused. Outside a Preview the context is returned
// unchanged.
//
// A call that carries the session holds the Preview's in-flight lock until it is
// released, and the Preview's end waits for that lock before it aborts. So a call
// either passes the ended check and runs inside the transaction, or is refused:
// none can reach the server after the abort, when the session has no transaction
// and the command would commit on its own.
func (s *Store) guardCall(ctx context.Context, database string, document stores.Doc) (context.Context, func(), error) {
	name := ""
	if len(document) > 0 {
		name = document[0].Key
	}
	if !sendproof.IsPreview(ctx) {
		// A write that carries no request while a Preview is open is taken to be
		// that Preview's and refused before it is sent (spec/data-stores.md,
		// "Writes the binding can't attribute to a request"). Attributed and
		// Detached writes, and every write with no Preview open, go on.
		if stores.ClassifyMongo(document, s.reads).Kind == stores.Write {
			if err := s.refuseUnattributed(ctx, name); err != nil {
				return nil, noRelease, err
			}
		}
		return ctx, noRelease, nil
	}
	if endsTransaction(lower(name)) {
		return nil, noRelease, sendproof.RefusePreview(ctx, "Preview owns the MongoDB transaction, so the handler's "+name+" cannot run during Preview.")
	}
	state := s.previewOf(ctx)
	classified := stores.ClassifyMongo(document, s.reads)
	if state != nil && state.session != nil {
		// Preview mode: commands run in the Preview's transaction.
		if foreign := mongo.SessionFromContext(ctx); foreign != nil && foreign != state.session {
			return nil, noRelease, sendproof.RefusePreview(ctx, "A MongoDB "+name+" was sent with a session other than the Preview's.")
		}
		if state.ended() {
			return nil, noRelease, sendproof.RefusePreview(ctx, endedReason)
		}
		if !systemDatabase(database) {
			if classified.Refused != "" {
				return nil, noRelease, sendproof.Guard(ctx, system, name, true, refusedReason(classified.Refused))
			}
			state.inflight.RLock()
			// Checked again under the lock: the Preview may have ended while this call waited for it.
			if state.ended() {
				state.inflight.RUnlock()
				return nil, noRelease, sendproof.RefusePreview(ctx, endedReason)
			}
			if hook := windowHooks.afterCheck; hook != nil {
				hook()
			}
			return mongo.NewSessionContext(ctx, state.session), state.inflight.RUnlock, nil
		}
	}
	// Guard mode, a handler that was never marked, or a system database: reads run
	// and every write is refused.
	if err := sendproof.Guard(ctx, system, name, classified.Kind == stores.Write, ""); err != nil {
		return nil, noRelease, err
	}
	return ctx, noRelease, nil
}

// refuseUnattributed refuses an unattributed write while a Preview is open: in
// preview mode every open Preview answers 500 without confirmation, in guard mode
// (or before the topology is known) it is blocked and answers 409.
func (s *Store) refuseUnattributed(ctx context.Context, name string) error {
	s.mu.Lock()
	detected := s.detected
	s.mu.Unlock()
	if detected != nil && detected.mode == sendproof.ModePreview {
		return sendproof.RefuseUnattributedWrite(ctx, system, name)
	}
	return sendproof.Guard(ctx, system, name, true, "")
}

// endedReason refuses a call from a Preview whose transaction is over.
const endedReason = "The Preview's MongoDB transaction has ended, so its handles refuse every further call."

// failedResult is a SingleResult that carries err, for methods that return one.
func failedResult(err error) *mongo.SingleResult {
	return mongo.NewSingleResultFromDocument(bson.D{}, err, nil)
}

// ---- Client ----

// Client is the guarded *mongo.Client. Create it with Store.Client.
type Client struct {
	store *Store
	raw   *mongo.Client
}

// Client returns the guarded handle of a client created with ClientOptions.
func (s *Store) Client(client *mongo.Client) *Client {
	s.attach(client)
	return &Client{store: s, raw: client}
}

// Ping checks that the server answers. A ping never writes, so it is not guarded.
func (c *Client) Ping(ctx context.Context) error { return c.raw.Ping(ctx, nil) }

// Disconnect closes the client's connections, as mongo.Client.Disconnect does.
func (c *Client) Disconnect(ctx context.Context) error { return c.raw.Disconnect(ctx) }

// Database returns the guarded handle of one database.
func (c *Client) Database(name string, opts ...options.Lister[options.DatabaseOptions]) *Database {
	return &Database{store: c.store, raw: c.raw.Database(name, opts...)}
}

// BulkWrite runs a client-level bulk write across namespaces.
func (c *Client) BulkWrite(ctx context.Context, writes []mongo.ClientBulkWrite, opts ...options.Lister[options.ClientBulkWriteOptions]) (*mongo.ClientBulkWriteResult, error) {
	ctx, release, err := c.store.guardCall(ctx, "", command("bulkWrite", "admin"))
	if err != nil {
		return nil, err
	}
	defer release()
	return c.raw.BulkWrite(ctx, writes, opts...)
}

// UseSession runs fn in a session. During a Preview fn runs in the Preview's
// transaction instead of a new one: the guarded handles add the Preview's session
// to each call, and fn's context carries no driver session, so
// mongo.SessionFromContext returns nil and the Preview's transaction can never be
// committed from the handler.
func (c *Client) UseSession(ctx context.Context, fn func(context.Context) error) error {
	if state := c.store.previewOf(ctx); sendproof.IsPreview(ctx) && state != nil && state.session != nil {
		return fn(ctx)
	}
	return c.raw.UseSession(ctx, fn)
}

// Session is a handler's session. During a Preview it joins the Preview's
// transaction: starting a transaction is a no-op, WithTransaction runs its body in
// the Preview's, and committing or aborting is refused and fails the Preview.
type Session struct {
	store *Store
	ctx   context.Context
	raw   *mongo.Session
}

// StartSession starts a session for ctx's request.
func (c *Client) StartSession(ctx context.Context, opts ...options.Lister[options.SessionOptions]) (*Session, error) {
	if state := c.store.previewOf(ctx); sendproof.IsPreview(ctx) && state != nil && state.session != nil {
		return &Session{store: c.store, ctx: ctx}, nil
	}
	raw, err := c.raw.StartSession(opts...)
	if err != nil {
		return nil, err
	}
	return &Session{store: c.store, ctx: ctx, raw: raw}, nil
}

func (s *Session) joined() *preview {
	if state := s.store.previewOf(s.ctx); sendproof.IsPreview(s.ctx) && state != nil && state.session != nil {
		return state
	}
	return nil
}

// StartTransaction starts a transaction; during a Preview the Preview's is already running.
func (s *Session) StartTransaction(opts ...options.Lister[options.TransactionOptions]) error {
	if s.joined() != nil || s.raw == nil {
		return nil
	}
	return s.raw.StartTransaction(opts...)
}

// WithTransaction runs fn in a transaction: during a Preview, the Preview's own.
// As with UseSession, fn's context then carries no driver session; the guarded
// handles join the Preview's transaction on every call.
func (s *Session) WithTransaction(ctx context.Context, fn func(context.Context) (any, error), opts ...options.Lister[options.TransactionOptions]) (any, error) {
	if s.joined() != nil {
		return fn(ctx)
	}
	return s.raw.WithTransaction(ctx, fn, opts...)
}

// Context returns ctx bound to the session, for the guarded calls a handler makes
// between StartTransaction and CommitTransaction. During a Preview it returns ctx
// unchanged, because the guarded handles already join the Preview's transaction.
func (s *Session) Context(ctx context.Context) context.Context {
	if s.joined() != nil || s.raw == nil {
		return ctx
	}
	return mongo.NewSessionContext(ctx, s.raw)
}

// CommitTransaction commits; during a Preview it is refused and fails the Preview.
func (s *Session) CommitTransaction(ctx context.Context) error {
	if s.joined() != nil || sendproof.IsPreview(ctx) {
		return sendproof.RefusePreview(ctx, "Preview owns the MongoDB transaction, so the handler's commitTransaction cannot run during Preview.")
	}
	return s.raw.CommitTransaction(ctx)
}

// AbortTransaction aborts; during a Preview it is refused and fails the Preview.
func (s *Session) AbortTransaction(ctx context.Context) error {
	if s.joined() != nil || sendproof.IsPreview(ctx) {
		return sendproof.RefusePreview(ctx, "Preview owns the MongoDB transaction, so the handler's abortTransaction cannot run during Preview.")
	}
	return s.raw.AbortTransaction(ctx)
}

// EndSession ends the handler's session; the Preview ends its own.
func (s *Session) EndSession(ctx context.Context) {
	if s.raw != nil {
		s.raw.EndSession(ctx)
	}
}

// ---- Database ----

// Database is the guarded *mongo.Database.
type Database struct {
	store *Store
	raw   *mongo.Database
}

// Database returns the guarded handle of a database of the store's client.
func (s *Store) Database(db *mongo.Database) *Database {
	s.attach(db.Client())
	return &Database{store: s, raw: db}
}

// Name returns the database name.
func (d *Database) Name() string { return d.raw.Name() }

// Collection returns the guarded handle of a collection.
func (d *Database) Collection(name string, opts ...options.Lister[options.CollectionOptions]) *Collection {
	return &Collection{store: d.store, raw: d.raw.Collection(name, opts...), database: d.raw.Name()}
}

// RunCommand runs a command document. It is classified by its first key; a raw
// commitTransaction or abortTransaction is refused during a Preview. The command
// is marshalled once and those bytes are sent, so the driver sends exactly the
// document the guard classified (a bson.M may order its keys differently each time).
func (d *Database) RunCommand(ctx context.Context, runCommand any, opts ...options.Lister[options.RunCmdOptions]) *mongo.SingleResult {
	raw, err := toRaw(runCommand)
	if err != nil {
		return failedResult(err)
	}
	ctx, release, err := d.store.guardCall(ctx, d.raw.Name(), rawToDoc(raw))
	if err != nil {
		return failedResult(err)
	}
	defer release()
	return d.raw.RunCommand(ctx, raw, opts...)
}

// Aggregate runs a database-level aggregation.
func (d *Database) Aggregate(ctx context.Context, pipeline any, opts ...options.Lister[options.AggregateOptions]) (*mongo.Cursor, error) {
	ctx, release, err := d.store.guardCall(ctx, d.raw.Name(), pipelineDoc("1", pipeline))
	if err != nil {
		return nil, err
	}
	defer release()
	return d.raw.Aggregate(ctx, pipeline, opts...)
}

// CreateCollection creates a collection. MongoDB refuses an explicit create inside a
// transaction, so a Preview is blocked with the reason; insert into the collection
// instead, which creates it and rolls back.
func (d *Database) CreateCollection(ctx context.Context, name string, opts ...options.Lister[options.CreateCollectionOptions]) error {
	ctx, release, err := d.store.guardCall(ctx, d.raw.Name(), command("create", name))
	if err != nil {
		return err
	}
	defer release()
	return d.raw.CreateCollection(ctx, name, opts...)
}

// Drop drops the database.
func (d *Database) Drop(ctx context.Context) error {
	ctx, release, err := d.store.guardCall(ctx, d.raw.Name(), command("dropDatabase", "1"))
	if err != nil {
		return err
	}
	defer release()
	return d.raw.Drop(ctx)
}

// ListCollectionNames lists the collection names.
func (d *Database) ListCollectionNames(ctx context.Context, filter any, opts ...options.Lister[options.ListCollectionsOptions]) ([]string, error) {
	ctx, release, err := d.store.guardCall(ctx, d.raw.Name(), command("listCollections", "1"))
	if err != nil {
		return nil, err
	}
	defer release()
	return d.raw.ListCollectionNames(ctx, filter, opts...)
}

// ---- Collection ----

// Collection is the guarded *mongo.Collection.
type Collection struct {
	store    *Store
	raw      *mongo.Collection
	database string
}

// Name returns the collection name.
func (c *Collection) Name() string { return c.raw.Name() }

// guard classifies one method's command. The caller defers the release it returns.
func (c *Collection) guard(ctx context.Context, name string) (context.Context, func(), error) {
	return c.store.guardCall(ctx, c.database, command(name, c.raw.Name()))
}

// InsertOne inserts a document.
func (c *Collection) InsertOne(ctx context.Context, document any, opts ...options.Lister[options.InsertOneOptions]) (*mongo.InsertOneResult, error) {
	ctx, release, err := c.guard(ctx, "insert")
	if err != nil {
		return nil, err
	}
	defer release()
	return c.raw.InsertOne(ctx, document, opts...)
}

// InsertMany inserts documents.
func (c *Collection) InsertMany(ctx context.Context, documents any, opts ...options.Lister[options.InsertManyOptions]) (*mongo.InsertManyResult, error) {
	ctx, release, err := c.guard(ctx, "insert")
	if err != nil {
		return nil, err
	}
	defer release()
	return c.raw.InsertMany(ctx, documents, opts...)
}

// DeleteOne deletes one document.
func (c *Collection) DeleteOne(ctx context.Context, filter any, opts ...options.Lister[options.DeleteOneOptions]) (*mongo.DeleteResult, error) {
	ctx, release, err := c.guard(ctx, "delete")
	if err != nil {
		return nil, err
	}
	defer release()
	return c.raw.DeleteOne(ctx, filter, opts...)
}

// DeleteMany deletes the matching documents.
func (c *Collection) DeleteMany(ctx context.Context, filter any, opts ...options.Lister[options.DeleteManyOptions]) (*mongo.DeleteResult, error) {
	ctx, release, err := c.guard(ctx, "delete")
	if err != nil {
		return nil, err
	}
	defer release()
	return c.raw.DeleteMany(ctx, filter, opts...)
}

// UpdateOne updates one document.
func (c *Collection) UpdateOne(ctx context.Context, filter, update any, opts ...options.Lister[options.UpdateOneOptions]) (*mongo.UpdateResult, error) {
	ctx, release, err := c.guard(ctx, "update")
	if err != nil {
		return nil, err
	}
	defer release()
	return c.raw.UpdateOne(ctx, filter, update, opts...)
}

// UpdateMany updates the matching documents.
func (c *Collection) UpdateMany(ctx context.Context, filter, update any, opts ...options.Lister[options.UpdateManyOptions]) (*mongo.UpdateResult, error) {
	ctx, release, err := c.guard(ctx, "update")
	if err != nil {
		return nil, err
	}
	defer release()
	return c.raw.UpdateMany(ctx, filter, update, opts...)
}

// UpdateByID updates the document with the given _id.
func (c *Collection) UpdateByID(ctx context.Context, id, update any, opts ...options.Lister[options.UpdateOneOptions]) (*mongo.UpdateResult, error) {
	ctx, release, err := c.guard(ctx, "update")
	if err != nil {
		return nil, err
	}
	defer release()
	return c.raw.UpdateByID(ctx, id, update, opts...)
}

// ReplaceOne replaces one document.
func (c *Collection) ReplaceOne(ctx context.Context, filter, replacement any, opts ...options.Lister[options.ReplaceOptions]) (*mongo.UpdateResult, error) {
	ctx, release, err := c.guard(ctx, "update")
	if err != nil {
		return nil, err
	}
	defer release()
	return c.raw.ReplaceOne(ctx, filter, replacement, opts...)
}

// BulkWrite runs a bulk write on the collection.
func (c *Collection) BulkWrite(ctx context.Context, models []mongo.WriteModel, opts ...options.Lister[options.BulkWriteOptions]) (*mongo.BulkWriteResult, error) {
	ctx, release, err := c.guard(ctx, "bulkWrite")
	if err != nil {
		return nil, err
	}
	defer release()
	return c.raw.BulkWrite(ctx, models, opts...)
}

// Aggregate runs an aggregation. The whole pipeline, at any depth, is checked for
// $out and $merge before anything is sent.
func (c *Collection) Aggregate(ctx context.Context, pipeline any, opts ...options.Lister[options.AggregateOptions]) (*mongo.Cursor, error) {
	ctx, release, err := c.store.guardCall(ctx, c.database, pipelineDoc(c.raw.Name(), pipeline))
	if err != nil {
		return nil, err
	}
	defer release()
	return c.raw.Aggregate(ctx, pipeline, opts...)
}

// CountDocuments counts the matching documents with an aggregation, which a transaction allows.
func (c *Collection) CountDocuments(ctx context.Context, filter any, opts ...options.Lister[options.CountOptions]) (int64, error) {
	ctx, release, err := c.guard(ctx, "aggregate")
	if err != nil {
		return 0, err
	}
	defer release()
	return c.raw.CountDocuments(ctx, filter, opts...)
}

// EstimatedDocumentCount uses the count command, which MongoDB refuses inside a
// transaction: a Preview is blocked with the reason. Use CountDocuments.
func (c *Collection) EstimatedDocumentCount(ctx context.Context, opts ...options.Lister[options.EstimatedDocumentCountOptions]) (int64, error) {
	ctx, release, err := c.guard(ctx, "count")
	if err != nil {
		return 0, err
	}
	defer release()
	return c.raw.EstimatedDocumentCount(ctx, opts...)
}

// Distinct returns the distinct values of a field. Unlike the driver it also
// returns the error of a refused call, because a DistinctResult cannot carry one.
func (c *Collection) Distinct(ctx context.Context, fieldName string, filter any, opts ...options.Lister[options.DistinctOptions]) (*mongo.DistinctResult, error) {
	ctx, release, err := c.guard(ctx, "distinct")
	if err != nil {
		return nil, err
	}
	defer release()
	return c.raw.Distinct(ctx, fieldName, filter, opts...), nil
}

// Find finds the matching documents.
func (c *Collection) Find(ctx context.Context, filter any, opts ...options.Lister[options.FindOptions]) (*mongo.Cursor, error) {
	ctx, release, err := c.guard(ctx, "find")
	if err != nil {
		return nil, err
	}
	defer release()
	return c.raw.Find(ctx, filter, opts...)
}

// FindOne finds one document.
func (c *Collection) FindOne(ctx context.Context, filter any, opts ...options.Lister[options.FindOneOptions]) *mongo.SingleResult {
	ctx, release, err := c.guard(ctx, "find")
	if err != nil {
		return failedResult(err)
	}
	defer release()
	return c.raw.FindOne(ctx, filter, opts...)
}

// FindOneAndDelete finds and deletes one document. It is always a write.
func (c *Collection) FindOneAndDelete(ctx context.Context, filter any, opts ...options.Lister[options.FindOneAndDeleteOptions]) *mongo.SingleResult {
	ctx, release, err := c.guard(ctx, "findAndModify")
	if err != nil {
		return failedResult(err)
	}
	defer release()
	return c.raw.FindOneAndDelete(ctx, filter, opts...)
}

// FindOneAndReplace finds and replaces one document. It is always a write.
func (c *Collection) FindOneAndReplace(ctx context.Context, filter, replacement any, opts ...options.Lister[options.FindOneAndReplaceOptions]) *mongo.SingleResult {
	ctx, release, err := c.guard(ctx, "findAndModify")
	if err != nil {
		return failedResult(err)
	}
	defer release()
	return c.raw.FindOneAndReplace(ctx, filter, replacement, opts...)
}

// FindOneAndUpdate finds and updates one document. It is always a write.
func (c *Collection) FindOneAndUpdate(ctx context.Context, filter, update any, opts ...options.Lister[options.FindOneAndUpdateOptions]) *mongo.SingleResult {
	ctx, release, err := c.guard(ctx, "findAndModify")
	if err != nil {
		return failedResult(err)
	}
	defer release()
	return c.raw.FindOneAndUpdate(ctx, filter, update, opts...)
}

// Drop drops the collection.
func (c *Collection) Drop(ctx context.Context, opts ...options.Lister[options.DropCollectionOptions]) error {
	ctx, release, err := c.guard(ctx, "drop")
	if err != nil {
		return err
	}
	defer release()
	return c.raw.Drop(ctx, opts...)
}

// CreateIndex creates one index. It is a write, and refused inside a transaction on
// an existing collection.
func (c *Collection) CreateIndex(ctx context.Context, model mongo.IndexModel, opts ...options.Lister[options.CreateIndexesOptions]) (string, error) {
	ctx, release, err := c.guard(ctx, "createIndexes")
	if err != nil {
		return "", err
	}
	defer release()
	return c.raw.Indexes().CreateOne(ctx, model, opts...)
}

// DropIndex drops one index by name.
func (c *Collection) DropIndex(ctx context.Context, name string, opts ...options.Lister[options.DropIndexesOptions]) error {
	ctx, release, err := c.guard(ctx, "dropIndexes")
	if err != nil {
		return err
	}
	defer release()
	return c.raw.Indexes().DropOne(ctx, name, opts...)
}

// ListIndexes lists the indexes. MongoDB refuses listIndexes inside a transaction.
func (c *Collection) ListIndexes(ctx context.Context, opts ...options.Lister[options.ListIndexesOptions]) (*mongo.Cursor, error) {
	ctx, release, err := c.guard(ctx, "listIndexes")
	if err != nil {
		return nil, err
	}
	defer release()
	return c.raw.Indexes().List(ctx, opts...)
}
