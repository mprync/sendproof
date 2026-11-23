package mongobench

import (
	"context"
	"encoding/json"
	"errors"
	"sort"

	"github.com/mprync/sendproof/adapters/go/sendproof"
	"github.com/mprync/sendproof/adapters/go/stores"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// Snapshot a target before its first write in a step. This preserves before
// images even when a filter depends on earlier steps, the write changes the
// filter fields, or a bulk command touches several documents.
const heldImageBudget = 32 << 20

type collectionName struct{ database, collection string }
type documentImages map[string]bson.Raw
type heldCallKey struct{}

type heldDocuments struct {
	step         int
	captured     bool
	before       map[collectionName]documentImages
	bytes        int
	history      [][]documentEdit
	historyBytes int
}

type documentEdit struct {
	target        collectionName
	key           bson.RawValue
	before, after bson.Raw
}

func (p *preview) StartStep(_ context.Context, step int) error {
	p.inflight.Lock()
	defer p.inflight.Unlock()
	if p.ended() {
		return sendproof.ErrSessionFailed
	}
	p.held.step = step
	p.held.captured = false
	p.held.before = make(map[collectionName]documentImages)
	p.held.bytes = 0
	p.mu.Lock()
	p.candidates, p.order, p.filters = make(map[string]candidate), nil, nil
	p.mu.Unlock()
	return nil
}

func (p *preview) guardHeldCall(ctx context.Context, database string, doc stores.Doc, write bool, targets []collectionName) (context.Context, func(), error) {
	p.inflight.Lock() // the MongoDB driver session may only run one command at a time
	if p.ended() || !sendproof.IsPreviewStepActive(ctx) {
		p.inflight.Unlock()
		return nil, noRelease, sendproof.ErrSessionFailed
	}
	if write {
		var name, collection string
		if len(doc) != 0 {
			name = doc[0].Key
			collection, _ = doc[0].Value.(string)
		}
		switch lower(name) {
		case "insert", "update", "delete", "findandmodify":
			targets = []collectionName{{database, collection}}
		case "bulkwrite":
			if len(targets) == 0 && database != "" {
				targets = []collectionName{{database, collection}}
			}
		default:
			targets = nil
		}
		var err error
		if len(targets) == 0 {
			err = sendproof.Guard(ctx, system, name, true, "Preview unavailable: MongoDB cannot rewind this command")
		}
		for _, target := range targets {
			if err != nil {
				break
			}
			err = p.saveBefore(ctx, name, target)
		}
		if err != nil {
			p.inflight.Unlock()
			return nil, noRelease, err
		}
		ctx = context.WithValue(ctx, heldCallKey{}, p)
	}
	return mongo.NewSessionContext(ctx, p.session), p.inflight.Unlock, nil
}

var errImagesTooLarge = errors.New("mongobench: the MongoDB Preview session image limit was exceeded")

func (p *preview) saveBefore(ctx context.Context, operation string, target collectionName) error {
	if target.database == "" || target.collection == "" || systemDatabase(target.database) {
		return sendproof.Guard(ctx, system, operation, true, "Preview unavailable: MongoDB cannot rewind this command target")
	}
	if _, saved := p.held.before[target]; saved {
		return nil
	}
	images, size, err := p.readImages(ctx, target, heldImageBudget-p.held.historyBytes-p.held.bytes)
	if errors.Is(err, errImagesTooLarge) {
		return sendproof.Guard(ctx, system, operation, true, "Preview unavailable: the MongoDB Preview session image limit was exceeded")
	}
	if err != nil {
		return err
	}
	p.held.before[target] = images
	p.held.bytes += size
	return nil
}

func (p *preview) readImages(ctx context.Context, target collectionName, budget int) (documentImages, int, error) {
	p.mu.Lock()
	p.sent = true
	p.mu.Unlock()
	ctx = mongo.NewSessionContext(internal(ctx), p.session)
	cursor, err := p.collection(target).Find(ctx, bson.D{})
	if err != nil {
		return nil, 0, heldMongoError(err)
	}
	defer cursor.Close(ctx)
	images, size := make(documentImages), 0
	for cursor.Next(ctx) {
		size += len(cursor.Current)
		if size > budget || len(images) == candidateLimit {
			return nil, 0, errImagesTooLarge
		}
		key := cursor.Current.Lookup("_id")
		images[imageKey(key)] = append(bson.Raw(nil), cursor.Current...)
	}
	return images, size, heldMongoError(cursor.Err())
}

func (p *preview) collection(target collectionName) *mongo.Collection {
	return p.store.client.Database(target.database).Collection(target.collection)
}

func imageKey(key bson.RawValue) string { return string(extJSONValue("_id", key)) }

func (p *preview) CaptureStep(ctx context.Context) error {
	p.inflight.Lock()
	defer p.inflight.Unlock()
	edits, err := p.stepEdits(ctx)
	if err != nil {
		return err
	}
	var size int
	for _, edit := range edits {
		size += edit.size()
	}
	if p.held.historyBytes+size > heldImageBudget {
		return errImagesTooLarge
	}
	for _, edit := range edits {
		change := sendproof.Change{
			Store: system, Namespace: edit.target.database, Table: edit.target.collection,
			Key: json.RawMessage(extJSONValue("_id", edit.key)), Operation: "update",
		}
		if edit.before != nil {
			change.Before = json.RawMessage(extJSON(edit.before))
		} else {
			change.Operation = "insert"
		}
		if edit.after != nil {
			change.After = json.RawMessage(extJSON(edit.after))
			p.mu.Lock()
			change.Via = p.candidates[edit.target.database+"\x00"+edit.target.collection+"\x00"+imageKey(edit.key)].via
			p.mu.Unlock()
		} else {
			change.Operation = "delete"
		}
		sendproof.RecordChange(ctx, change)
	}
	p.held.history = append(p.held.history, edits)
	p.held.historyBytes += size
	p.held.captured = true
	p.held.before = nil
	return nil
}

func (e documentEdit) size() int { return len(e.before) + len(e.after) }

func (p *preview) stepEdits(ctx context.Context) ([]documentEdit, error) {
	if p.ended() {
		return nil, sendproof.ErrSessionFailed
	}
	p.mu.Lock()
	ended := p.heldFailed
	p.mu.Unlock()
	if ended {
		return nil, sendproof.ErrSessionFailed
	}
	var result []documentEdit
	budget := heldImageBudget
	for target, before := range p.held.before {
		after, size, err := p.readImages(ctx, target, budget)
		if err != nil {
			return nil, err
		}
		budget -= size
		for key, old := range before {
			current := after[key]
			delete(after, key)
			if !sameDocument(old, current) {
				result = append(result, documentEdit{target, old.Lookup("_id"), old, current})
			}
		}
		for _, added := range after {
			result = append(result, documentEdit{target, added.Lookup("_id"), nil, added})
		}
	}
	sort.Slice(result, func(i, j int) bool {
		left, right := result[i], result[j]
		if left.target.database != right.target.database {
			return left.target.database < right.target.database
		}
		if left.target.collection != right.target.collection {
			return left.target.collection < right.target.collection
		}
		return imageKey(left.key) < imageKey(right.key)
	})
	return result, nil
}

func (p *preview) Rewind(ctx context.Context, step int) error {
	p.inflight.Lock()
	defer p.inflight.Unlock()
	if !p.held.captured && p.held.step >= step {
		edits, err := p.stepEdits(ctx)
		if err != nil {
			return err
		}
		if err := p.restore(ctx, edits); err != nil {
			return err
		}
	}
	for index := len(p.held.history) - 1; index >= step-1; index-- {
		edits := p.held.history[index]
		if err := p.restore(ctx, edits); err != nil {
			return err
		}
		for _, edit := range edits {
			p.held.historyBytes -= edit.size()
		}
		p.held.history[index] = nil
	}
	p.held.history = p.held.history[:step-1]
	p.held.before = nil
	p.held.step = step - 1
	return nil
}

func (p *preview) restore(ctx context.Context, edits []documentEdit) error {
	if p.ended() {
		return sendproof.ErrSessionFailed
	}
	ctx = mongo.NewSessionContext(internal(ctx), p.session)
	for _, edit := range edits {
		if edit.before != nil {
			continue
		}
		filter := bson.D{{Key: "_id", Value: edit.key}}
		if _, err := p.collection(edit.target).DeleteOne(ctx, filter); err != nil {
			return heldMongoError(err)
		}
	}
	for _, edit := range edits {
		if edit.before == nil {
			continue
		}
		collection := p.collection(edit.target)
		if edit.after == nil {
			if _, err := collection.InsertOne(ctx, edit.before); err != nil {
				return heldMongoError(err)
			}
			continue
		}
		filter := bson.D{{Key: "_id", Value: edit.key}}
		if result, err := collection.ReplaceOne(ctx, filter, edit.before); err != nil {
			return heldMongoError(err)
		} else if result.MatchedCount != 1 {
			return errors.New("mongobench: a document was missing during rewind")
		}
	}
	return nil
}

func heldMongoError(err error) error {
	if isCode(err, noSuchTransaction) {
		return errors.Join(sendproof.ErrSessionFailed, err)
	}
	return err
}
