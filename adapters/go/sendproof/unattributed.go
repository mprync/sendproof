package sendproof

import (
	"context"
	"sync"
	"sync/atomic"
)

// Go passes the request to a store call only through the context the caller
// gives it. A handler that calls a hooked store with context.Background() sends
// a write the guard cannot attribute to its Preview: it is neither blocked nor
// rolled back. The hook cannot tell that write apart from background work, so
// while any Preview is open such a write fails every open Preview with 500
// rather than let one confirm a rollback that did not happen
// (spec/data-stores.md, "a confirmed Preview never leaves a write behind").
//
// A write counts as attributed when its context carries a Preview or observed
// Send, any request that passed through Middleware, or the Detached mark.

// requestKey marks the context of every request that passed through Middleware.
type requestKey struct{}

// detachedKey marks background work that belongs to no request.
type detachedKey struct{}

// Detached marks ctx as background work that belongs to no request, such as a
// job worker or a scheduled task, so its data-store writes never fail an open
// Preview. Use it only outside request handlers: a handler that sends a write
// with a detached context escapes its Preview, like a client that was never hooked.
func Detached(ctx context.Context) context.Context {
	return context.WithValue(ctx, detachedKey{}, true)
}

// openPreviews holds the Previews whose handler may still be running. The count
// keeps the common case, no open Preview, to one atomic load.
var openPreviews struct {
	count  atomic.Int64
	mu     sync.Mutex
	states map[*requestState]struct{}
}

// openPreview registers a Preview for the time its handler and cleanup run.
func openPreview(state *requestState) {
	openPreviews.mu.Lock()
	defer openPreviews.mu.Unlock()
	if openPreviews.states == nil {
		openPreviews.states = map[*requestState]struct{}{}
	}
	openPreviews.states[state] = struct{}{}
	openPreviews.count.Store(int64(len(openPreviews.states)))
}

// closePreview removes a Preview registered with openPreview.
func closePreview(state *requestState) {
	openPreviews.mu.Lock()
	defer openPreviews.mu.Unlock()
	delete(openPreviews.states, state)
	openPreviews.count.Store(int64(len(openPreviews.states)))
}

// attributed reports whether ctx belongs to a request Sendproof saw, or was
// marked Detached.
func attributed(ctx context.Context) bool {
	if stateFrom(ctx) != nil {
		return true
	}
	if marked, _ := ctx.Value(requestKey{}).(bool); marked {
		return true
	}
	marked, _ := ctx.Value(detachedKey{}).(bool)
	return marked
}

// ReportWrite tells Sendproof that a store hook let a write through. A write
// whose context belongs to no request Sendproof saw, sent while a Preview is
// open, may come from that Preview's handler calling the store with
// context.Background(): every open Preview then answers 500 without
// confirmation. Guard reports the writes it is asked about itself; a hook that
// sees writes Guard never saw, such as a MongoDB command monitor, calls ReportWrite.
func ReportWrite(ctx context.Context, store, operation string) {
	if openPreviews.count.Load() == 0 || attributed(ctx) {
		return
	}
	failOpenPreviews(unattributedReason(store, operation))
}

func unattributedReason(store, operation string) string {
	return "A " + StoreName(store) + " " + operation + " was sent without a request context while this Preview ran. " +
		"Sendproof can't tell it apart from the Preview's own writes, so the Preview can't be confirmed. " +
		"Pass the request's context to every store call, and mark background work with sendproof.Detached."
}

// failOpenPreviews makes every open Preview answer 500 without confirmation.
func failOpenPreviews(reason string) {
	openPreviews.mu.Lock()
	states := make([]*requestState, 0, len(openPreviews.states))
	for state := range openPreviews.states {
		states = append(states, state)
	}
	openPreviews.mu.Unlock()
	for _, state := range states {
		state.mu.Lock()
		if state.fault == nil {
			state.fault = &PreviewTransactionControlError{Reason: clip(reason, maxText)}
		}
		state.mu.Unlock()
	}
}

// refuseUnattributed is the guard's rule for a write that carries no request
// (spec/data-stores.md, "Writes the binding can't attribute to a request"): a
// client's own background goroutine (a Firestore BulkWriter, a bulk indexer), a
// goroutine the handler started without the context, or a call made with
// context.Background(). While any Preview is open the write is taken to be that
// Preview's, so it is refused before it is sent and every open Preview is marked
// blocked, which answers 409 for the write's store and operation. Failing the
// Preview after the write landed would not be enough, because a guarded store
// cannot roll it back. A request that is not a Preview is attributed to its own
// request, and Detached work is never refused. It returns nil when the write may go on.
func refuseUnattributed(ctx context.Context, store, operation string) error {
	if openPreviews.count.Load() == 0 || attributed(ctx) {
		return nil
	}
	reason := WriteReason(store)
	openPreviews.mu.Lock()
	states := make([]*requestState, 0, len(openPreviews.states))
	for state := range openPreviews.states {
		states = append(states, state)
	}
	openPreviews.mu.Unlock()
	for _, state := range states {
		state.mu.Lock()
		if state.blocked == nil {
			state.blocked = &blockedWrite{store: clip(store, maxName), operation: clip(operation, maxName), detail: clip(reason, maxText)}
		}
		state.mu.Unlock()
	}
	return &PreviewWriteBlockedError{Store: store, Operation: operation, Reason: reason}
}
