package dbsql

import (
	"reflect"
	"sync"

	"github.com/test-bench/test-bench/adapters/go/testbench"
)

// rowEvent is one captured row change. Keyed and audit capture fill the maps
// directly; SQLite capture stores column values by position and resolves the
// column names once the request is over.
type rowEvent struct {
	table     tableName
	operation string // "insert", "update" or "delete"
	key       map[string]any
	before    map[string]any
	after     map[string]any

	// SQLite only: values by column position and the rowid of the row.
	rawBefore, rawAfter []any
	rowid               int64
}

// maxEvents bounds the events kept in memory. One more than the workbench shows
// is enough to report truncation honestly.
const maxEvents = testbench.MaxChanges + 1

// journal holds the row events of one request in statement order. Events of the
// open transaction are pending until it commits, and savepoint marks let a
// rollback to a savepoint discard exactly the events recorded after it. Positions
// are logical: events past maxEvents are counted, not kept, so a later rollback
// to a savepoint still lands on the right position.
type journal struct {
	mu sync.Mutex

	committed        []rowEvent
	committedDropped int
	pending          []rowEvent
	pendingDropped   int
	marks            []savepointMark

	// incomplete records that some writes could not be captured.
	incomplete bool
}

type savepointMark struct {
	name string
	at   int
}

func (j *journal) add(event rowEvent) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if len(j.committed)+len(j.pending) >= maxEvents || j.pendingDropped > 0 {
		j.pendingDropped++
		return
	}
	j.pending = append(j.pending, event)
}

// position returns the logical length of the open transaction's events.
func (j *journal) position() int {
	j.mu.Lock()
	defer j.mu.Unlock()
	return len(j.pending) + j.pendingDropped
}

// truncate discards the open transaction's events from the logical position on.
func (j *journal) truncate(position int) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.truncateLocked(position)
}

func (j *journal) truncateLocked(position int) {
	if position < 0 {
		position = 0
	}
	if position <= len(j.pending) {
		j.pending = j.pending[:position]
		j.pendingDropped = 0
		return
	}
	if position < len(j.pending)+j.pendingDropped {
		j.pendingDropped = position - len(j.pending)
	}
}

// savepoint applies a savepoint statement that the database accepted.
func (j *journal) savepoint(op savepointOp) {
	j.mu.Lock()
	defer j.mu.Unlock()
	find := func() int {
		for index := len(j.marks) - 1; index >= 0; index-- {
			if j.marks[index].name == op.name {
				return index
			}
		}
		return -1
	}
	switch op.kind {
	case "create":
		j.marks = append(j.marks, savepointMark{name: op.name, at: len(j.pending) + j.pendingDropped})
	case "rollback":
		if index := find(); index >= 0 {
			j.truncateLocked(j.marks[index].at)
			j.marks = j.marks[:index+1] // the savepoint itself remains
		}
	case "release":
		if index := find(); index >= 0 {
			j.marks = j.marks[:index]
		}
	}
}

// commit promotes the open transaction's events.
func (j *journal) commit() {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.committed = append(j.committed, j.pending...)
	j.committedDropped += j.pendingDropped
	j.pending, j.pendingDropped, j.marks = nil, 0, nil
}

// rollback discards the open transaction's events.
func (j *journal) rollback() {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.pending, j.pendingDropped, j.marks = nil, 0, nil
}

func (j *journal) markIncomplete() {
	j.mu.Lock()
	j.incomplete = true
	j.mu.Unlock()
}

// events returns the committed events, followed by the pending ones when
// includePending is set, as for a preview that never commits.
func (j *journal) events(includePending bool) (events []rowEvent, truncated bool) {
	j.mu.Lock()
	defer j.mu.Unlock()
	events = append(events, j.committed...)
	truncated = j.incomplete || j.committedDropped > 0
	if includePending {
		events = append(events, j.pending...)
		truncated = truncated || j.pendingDropped > 0
	}
	return events, truncated
}

// toChanges converts events to the workbench shape. Updates that leave every
// value unchanged are omitted.
func toChanges(events []rowEvent) []testbench.Change {
	changes := make([]testbench.Change, 0, len(events))
	for _, event := range events {
		if event.operation == "update" && reflect.DeepEqual(event.before, event.after) {
			continue
		}
		change := testbench.Change{Operation: event.operation, Table: event.table.String()}
		if event.key != nil {
			change.Key = event.key
		}
		if event.before != nil {
			change.Before = event.before
		}
		if event.after != nil {
			change.After = event.after
		}
		changes = append(changes, change)
	}
	return changes
}
