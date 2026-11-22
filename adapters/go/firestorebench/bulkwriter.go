package firestorebench

import (
	"context"

	"cloud.google.com/go/firestore"

	"github.com/mprync/sendproof/adapters/go/sendproof"
)

// bulkOperation is the RPC a BulkWriter's queued writes are sent with.
const bulkOperation = "BatchWrite"

// BulkWriter is a guarded firestore.BulkWriter. Firestore's BulkWriter queues
// writes and sends them later from its own goroutine, with the context it was
// created with and with automatic retries, so the interceptors see them only at
// send time and with the wrong context: a long-lived writer created for background
// work would send a write a Preview's handler queued. Each queueing method of
// BulkWriter takes the caller's context instead and refuses a write during a
// Preview, or with no request while a Preview is open, before it is queued, on
// the caller's goroutine (spec/data-stores.md, "Writes the binding can't attribute
// to a request"). Every queued write is a write.
type BulkWriter struct{ raw *firestore.BulkWriter }

// NewBulkWriter creates a guarded BulkWriter, like client.BulkWriter(ctx). ctx
// governs the writer's sends; mark it with sendproof.Detached for a writer that
// outlives requests. Build the client with ClientOptions, so the sends are
// guarded too.
func NewBulkWriter(ctx context.Context, client *firestore.Client) *BulkWriter {
	return &BulkWriter{raw: client.BulkWriter(ctx)}
}

// Create queues a create of doc, like firestore.BulkWriter.Create.
func (b *BulkWriter) Create(ctx context.Context, doc *firestore.DocumentRef, datum any) (*firestore.BulkWriterJob, error) {
	if err := sendproof.Guard(ctx, system, bulkOperation, true, ""); err != nil {
		return nil, err
	}
	return b.raw.Create(doc, datum)
}

// Set queues a set of doc, like firestore.BulkWriter.Set.
func (b *BulkWriter) Set(ctx context.Context, doc *firestore.DocumentRef, datum any, opts ...firestore.SetOption) (*firestore.BulkWriterJob, error) {
	if err := sendproof.Guard(ctx, system, bulkOperation, true, ""); err != nil {
		return nil, err
	}
	return b.raw.Set(doc, datum, opts...)
}

// Update queues an update of doc, like firestore.BulkWriter.Update.
func (b *BulkWriter) Update(ctx context.Context, doc *firestore.DocumentRef, updates []firestore.Update, preconds ...firestore.Precondition) (*firestore.BulkWriterJob, error) {
	if err := sendproof.Guard(ctx, system, bulkOperation, true, ""); err != nil {
		return nil, err
	}
	return b.raw.Update(doc, updates, preconds...)
}

// Delete queues a delete of doc, like firestore.BulkWriter.Delete.
func (b *BulkWriter) Delete(ctx context.Context, doc *firestore.DocumentRef, preconds ...firestore.Precondition) (*firestore.BulkWriterJob, error) {
	if err := sendproof.Guard(ctx, system, bulkOperation, true, ""); err != nil {
		return nil, err
	}
	return b.raw.Delete(doc, preconds...)
}

// Flush sends the queued writes and waits for them.
func (b *BulkWriter) Flush() { b.raw.Flush() }

// End sends the queued writes, waits for them and closes the writer.
func (b *BulkWriter) End() { b.raw.End() }
