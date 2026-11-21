# @sendproof/sqlite

Use the provider for operations whose SQL can share one Node SQLite connection. It wraps Preview in `BEGIN IMMEDIATE` and `ROLLBACK`, queues concurrent leases, and rejects writes from an expired preview context. The same methods perform ordinary autocommit writes during Send. The package is strict TypeScript and ships generated declarations.

```ts
import { SQLiteDatabase } from '@sendproof/sqlite';

const database = new SQLiteDatabase('inventory.db', {
  schema: 'CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, name TEXT NOT NULL)',
});

// Supply database as previewProvider, and use this same instance inside the route.
await database.write('INSERT INTO items (id, name) VALUES (:id, :name)',
  { id: 'A1', name: 'Bolt' }, { table: 'items', keys: [{ id: 'A1' }] });
```

The provider snapshots the rows whose primary keys you supply. Pass every affected key to capture a bulk statement. A key list longer than `trackedKeyLimit` (default 500) or a key that cannot be read marks the captured changes as truncated, and the statement still runs. Writes by triggers to other rows and tables are rolled back on the same connection. Their row changes need separate capture.

## Transactions and savepoints

`transaction(callback)` commits when the callback resolves and rolls back when it rejects. Called inside any transaction, including a Preview, it opens a savepoint instead. A released savepoint is retained: its writes stay in the enclosing transaction, so a Preview rollback still discards them. A failed savepoint rolls back alone and leaves the enclosing transaction usable. Savepoints opened from one scope run one at a time, and `database.depth` reports the nesting of the calling context (0 outside, 1 in a transaction, 2 in a savepoint).

```ts
await database.transaction(async () => {
  await database.write('INSERT INTO items (id, name) VALUES (:id, :name)', { id: 'B1', name: 'Nut' });
  await database.transaction(async () => { /* savepoint */ });
});
```

## Lock contention

SQLite reports a busy database as `SQLITE_BUSY` or `SQLITE_LOCKED`. Set `busyTimeoutMs` to let SQLite wait, and `retries` with `retryDelayMs` to attempt an outermost transaction again with doubling delays. Preview retries only the lock acquisition, never the dispatched request. `transaction` also runs its callback again, so the callback must be safe to repeat.

## Redaction

Positional bindings are always recorded as `[REDACTED]`. Named bindings pass through the capture, which redacts secret-named values and, unless the framework adapter sets `includeSqlParameterValues`, every other value.

The provider covers writes made through its connection. For workflows using multiple databases or independent connection pools, supply a provider that covers the full operation.

## Tests

`tests/sqlite.test.mts` runs 11 tests covering statement guards, change capture, rollback, expired scopes, transactions, nested savepoints, concurrency, retries, redaction, limits and option validation.
