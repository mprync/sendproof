# @sendproof/drizzle

Sendproof Preview and row-change capture for Drizzle ORM 0.45 on PostgreSQL, MySQL and SQLite, on Node 22.16 or newer. Preview runs the real operation in a transaction that is always rolled back. Row changes are identified by the primary key in the Drizzle table definition, so callers never pass row keys.

## Setup

### PostgreSQL and MySQL

Pass the application's Drizzle database. Supported drivers are `pg` over a `Pool`, `postgres`, PGlite, and `mysql2` over a pool.

```ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { drizzlePreview } from '@sendproof/drizzle';

const database = drizzlePreview(drizzle({ client: pool }));
// Pass `database` as the framework adapter's previewProvider, and query through database.client.
await database.client.insert(items).values({ id, name });
```

Create the MySQL database as `drizzle(pool, { mode: 'default' })`. Drizzle 0.45 does not recognise a `mysql2/promise` pool passed as `{ client }`. A single `pg` `Client` or `mysql2` connection is refused because every transaction would share it, so concurrent requests would run inside the Preview transaction.

### SQLite

Pass a `@sendproof/sqlite` database. The provider creates a Drizzle client over the same connection.

```ts
import { SQLiteDatabase } from '@sendproof/sqlite';

const database = drizzlePreview(new SQLiteDatabase('app.db'), { schema: { items } });
```

## The client

Use `client` for every query in operations that support Preview. Inside a Preview or a `client.transaction()` callback, each query runs on that transaction, including queries made through the outer `client`. `client.transaction()` inside a Preview, or nested in another transaction, becomes a savepoint. A failed savepoint rolls back on its own, and the capture drops the changes it undid. A statement that runs after its transaction's callback has settled is refused rather than run outside it.

Preview owns the outermost transaction. A statement that would end it is refused during Preview: `COMMIT`, `ROLLBACK` without `TO`, and `BEGIN`, plus MySQL statements that commit implicitly, such as DDL, including statements hidden in MySQL executable comments (`/*! ... */`), and MySQL `CALL`, because a stored procedure can commit. Declare procedures that never commit with `drizzlePreview(db, { safeProcedures: ['name', 'schema.name'] })` (exact names, no wildcards). **Warning:** a declared procedure that does commit keeps the handler's writes. A Preview with a refused statement fails even if the operation catches the error. After a MySQL deadlock or lock wait timeout the database has rolled the Preview transaction back: the handler gets the error, every later statement of that Preview is refused, and the Preview fails. On PostgreSQL and MySQL the provider sets the savepoint `sendproof_preview` when the Preview starts and rolls back to it before rolling back; any commit, even one sent through the driver directly, erases it, so a missing savepoint fails the Preview. SQLite Previews run through `@sendproof/sqlite`, which sets the same savepoint. Preview resolves only after the database acknowledges the rollback. If the rollback fails, or the session is lost, Preview rejects, and the transport withholds confirmation.

## Change capture

Inserts, updates and deletes built from `client`, including `client.with(...)`, report one change per affected row. Each change has the table, the key, the before and after rows by column name, and `insert`, `update` or `delete`.

- **Update and delete:** affected rows are read with the statement's own filter before it runs. PostgreSQL and MySQL lock them with `FOR UPDATE`. They are read again by key after it runs.
- **Insert with supplied keys:** rows are read by key afterwards. An upsert (`onConflictDoUpdate`, `onConflictDoNothing`, `onDuplicateKeyUpdate`, `ignore()`) also reads them beforehand, so an updated row shows its previous values.
- **Client-generated keys (`$defaultFn`):** the default is generated just before Drizzle builds the statement, so the key is known. Drizzle calls the function once per row either way.
- **Database-generated keys:**
  - **PostgreSQL:** the key columns are added to `RETURNING`. Requested `RETURNING` rows keep their requested shape. Without `RETURNING`, the driver's result keeps its row count and its rows are emptied.
  - **SQLite:** the inserted rowid range is read.
  - **MySQL:** the keys come from `insertId` and the transaction connection's `@@session.auto_increment_increment`, or from `$returningId()`.
- **Observed Send:** an autocommit statement runs in its own short transaction, so no other writer can change its rows between the reads and the statement.

Snapshot reads run on the same transaction. On PostgreSQL they run inside a savepoint, so a failed read cannot abort the application's transaction. A failed read marks captured changes as truncated and the statement still runs. The SQL log omits the provider's snapshot reads and transaction control.

Changes are marked as truncated instead of guessed when:

- the table has no primary key;
- more rows are affected than `trackedRowLimit` (default 500);
- a filter depends on a join, a `FROM` list or a CTE;
- a multi-row update assigns a primary key;
- an upsert with database-generated keys runs;
- a statement prepared with `.prepare()` runs;
- a key the database generates cannot be read back, such as for MySQL `INSERT … SELECT`, a MySQL table without a single auto-increment key, or SQLite rows that mix supplied and generated keys.

Raw `client.execute()` and `sql` statements are logged as SQL without row changes.

MySQL derives keys for a multi-row `INSERT … VALUES` from the first generated key and the session's auto-increment interval. With InnoDB lock mode 2, running this alongside concurrent bulk inserts can make the derived sequence incomplete. [MySQL auto-increment handling](https://dev.mysql.com/doc/refman/8.4/en/innodb-auto-increment-handling.html)

## SQL log and redaction

Statements are logged with their text, duration and rows affected. Drizzle sends positional parameters, which are logged as `$1`, `$2` and so on, and redacted because their names say nothing. Name them for one call with `withParameterNames(['fixture_secret'], () => client.execute(...))`. The capture then redacts secret-looking names, every value of a statement whose text names a secret, and, unless parameter values are enabled, every value. `withParameterNames` has no effect on SQLite, whose connection logs its own statements.

## API changes from 0.1.0-alpha.1

- **`drizzlePreview(database, options)`:** now also accepts PostgreSQL and MySQL Drizzle databases.
- **Options:** `trackedRowLimit` is new.
- **New members:** `dialect`, `withParameterNames()` and `dispose()`.
- **`track(rows, mutate)`:** still callable but deprecated. Keys now come from the table definition, so it simply runs `mutate`.
- **`client.transaction()`:** now works on SQLite as well.
- **`DrizzlePreview` type parameter:** it is now the client type, for example `DrizzlePreview<SqliteRemoteDatabase<Schema>>`. It used to be the schema.

## Tests

`tests/drizzle.test.mts` runs 55 tests across the supported drivers, including two configuration tests.

| Database | Driver | Tests | Last result |
| --- | --- | --- | --- |
| SQLite | `@sendproof/sqlite` | 10 | passed |
| PGlite | `@electric-sql/pglite` | 10 | passed |
| PostgreSQL 17 | `pg` | 11 | passed |
| PostgreSQL 17 | `postgres` | 10 | passed |
| MySQL 8.4 | `mysql2` | 12 | passed |
| — | configuration | 2 | passed |

The extra server test ends the database session during Preview and checks that Preview is not confirmed. It is skipped for `postgres` 3.4.7, which throws from a socket callback when its backend is terminated.

The PostgreSQL and MySQL suites run when `BENCH_POSTGRES_URL` and `BENCH_MYSQL_URL` are set. Each run creates a uniquely named database and drops it afterwards. The `node-express-drizzle`, `node-express-drizzle-postgresql` and `node-express-drizzle-mysql` conformance entries run the shared HTTP suite on SQLite, PostgreSQL and MySQL. The fixture reads `BENCH_DATABASE` and `BENCH_DATABASE_URL`.
