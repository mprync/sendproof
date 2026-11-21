# @sendproof/prisma

Sendproof Preview for Prisma 7 driver adapters. A Preview runs the request in one interactive Prisma transaction. It resolves only after the driver acknowledges the rollback. Model writes record their changed rows automatically, using primary keys that Prisma's schema metadata supplies.

## Supported databases

| Database | Driver adapter | Verified with |
| --- | --- | --- |
| SQLite | `@prisma/adapter-better-sqlite3` | 11/11 HTTP conformance checks, 11 local database tests |
| PostgreSQL | `@prisma/adapter-pg` | 11/11 HTTP conformance checks on PostgreSQL 17.12, 11 local database tests |
| MySQL | `@prisma/adapter-mariadb` | 11/11 HTTP conformance checks on MySQL 8.4.13, 12 local database tests |

The local suite also has 15 unit tests, for a total of 49 Prisma tests. All checks ran with Prisma 7.10.1. SQL Server, CockroachDB and other adapters are not verified.

## Setup

Add the Sendproof generator next to the client generator in `schema.prisma`:

```prisma
generator client {
  provider = "prisma-client"
  output   = "./generated"
}

generator sendproof {
  provider = "sendproof-prisma-generator"
  output   = "./generated/sendproof"
}
```

`prisma generate` now writes `generated/sendproof/index.js`. This file records each model's table, its key fields and the database names of its columns. The generator reads the key from Prisma's DMMF. It uses `@id` or `@@id` when present, and otherwise the first `@unique` or `@@unique` criterion. You don't list keys by hand.

Wrap the driver adapter before you create the client. Then attach the client:

```ts
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaPreview } from '@sendproof/prisma';
import { PrismaClient } from './generated/client.js';
import { models } from './generated/sendproof/index.js';

const preview = new PrismaPreview(new PrismaPg({ connectionString: process.env.DATABASE_URL }), { models });
preview.attach(new PrismaClient({ adapter: preview.adapter }));

// Pass `preview` to the framework binding as its previewProvider.
const item = await preview.run(client => client.item.update({ where: { id }, data: { name: 'Bolt' } }));
```

Run request database work through `preview.run(client => ...)`. During a Preview, the callback receives the transaction client. Otherwise it receives the attached client. `preview.client` is the attached client with capture enabled. With the `prisma-client-js` generator, you can pass `{ models: Prisma.dmmf }` in place of the generated file.

For MySQL 8 over plain loopback connections, add `allowPublicKeyRetrieval=true` to the MariaDB connector URL. `caching_sha2_password` needs it.

## What is captured

- **`create`, `update`, `upsert`, `delete`.** The provider reads the row by key before and after the write, inside the same transaction. It records an `insert`, `update` or `delete` with both snapshots. Generated keys, such as autoincrement IDs, come from the write result. If your `select` leaves out key fields, the provider adds them to the query and removes them from the result you receive.
- **`createMany`, `createManyAndReturn`, `updateMany`, `updateManyAndReturn`, `deleteMany`.** Each affected row is recorded. The provider reads at most `maxTrackedRows` rows (default 1000) for one write, and marks capture incomplete above that limit.
- **Marked incomplete (`changesTruncated`).** Capture is marked incomplete in these cases, and Preview and rollback still work:
  - `createMany` without key values in `data`
  - nested relation writes
  - bulk updates that change a key
  - models missing from the metadata
- **Not captured as changes.** Raw SQL (`$executeRaw`, `$queryRaw`) appears only in the SQL log. Use `preview.track({ table, key, lookup }, mutation)` to record those rows explicitly. Automatic capture is paused inside `track`.
- **Snapshot format.** Rows and keys use database table and column names (`@@map`, `@map`). `BigInt` values become strings, `Decimal` values use their JSON string, dates use ISO 8601 and bytes use base64.
- **Internal reads.** The provider's before and after reads do not appear in the captured SQL.

Positional SQL parameter values are always redacted. To name the parameters of one awaited query, use `withParameterNames(['fixture_secret'], () => ...)`.

## Rollback guarantees

The provider confirms a Preview only when all of the following hold:

1. The driver performed the physical rollback. The provider checks this in one of two ways:
   - Adapters with `usePhantomQuery` (MariaDB) roll back in `rollback()`.
   - Other adapters (pg, better-sqlite3) must complete Prisma's `ROLLBACK` statement before `rollback()` releases the connection.
2. Nothing committed the Preview transaction. On MySQL and MariaDB the provider sets the savepoint `sendproof_preview` when the Preview starts and releases it before the rollback; any commit erases it, so a missing savepoint fails the Preview.
3. No statement inside the transaction ended it early. The provider checks for:
   - `COMMIT`, `ROLLBACK`, `BEGIN`, `END` and `SET autocommit` anywhere in a `SET` list
   - on MySQL, statements that commit implicitly, such as `CREATE TABLE`, `TRUNCATE` and `LOCK TABLES`, SQL-level `PREPARE` and `EXECUTE`, and statements touching `sendproof_preview`
   - on MySQL, `CALL`, because a stored procedure can commit. Declare procedures that never commit with `safeProcedures: ['name', 'schema.name']` (exact names, no wildcards). **Warning:** a declared procedure that does commit keeps the handler's writes; the Preview still fails.

   Savepoints are allowed, so nested `$transaction` calls roll back with the Preview. After a MySQL deadlock or lock wait timeout the database has rolled the Preview transaction back, so the handler gets the error and every later statement of that Preview is refused.
4. On pooled databases (PostgreSQL, MySQL), nothing wrote through another connection or a separate transaction during the Preview. Reads through the root client are allowed. SQLite adapters share one connection, so their root-client statements run inside the Preview transaction.

Sendproof blocks the statements in cases 3 and 4 before sending them to the driver. Even if the handler catches the error, that Preview fails and its earlier writes roll back. A missing or failed rollback acknowledgment retires the client until the process restarts. Use `preview.run` for request work so the provider can enroll it in the transaction.

SQLite Previews and `run` calls are serialized, because the adapter has one connection. PostgreSQL and MySQL Previews run concurrently, each on its own pooled connection.

## Options

| Option | Meaning |
| --- | --- |
| `models` | Generated metadata or a `Prisma.dmmf` document. Enables automatic capture. |
| `maxTrackedRows` | Most rows read for one bulk write before capture is marked incomplete. Default 1000. |
| `transactionOptions` | `{ maxWait, timeout }` for the Preview `$transaction`. |

## Development

From `adapters/node`:

```sh
npx tsc -b prisma                                    # build dist/ and declarations
for db in sqlite postgresql mysql; do npx prisma generate --schema examples/prisma/$db/schema.prisma; done
node --test tests/prisma.test.mts tests/prisma-databases.test.mts
```

The database tests always run SQLite. They also run PostgreSQL and MySQL when `BENCH_POSTGRES_URL` and `BENCH_MYSQL_URL` are set. Each run creates a uniquely named database and drops it afterwards. The fixture (`examples/fixture-prisma.mjs`) reads two variables:

- `BENCH_DATABASE`: `sqlite`, `postgresql` or `mysql`
- `BENCH_DATABASE_URL`: the server database to use

The fixture creates its own table.
