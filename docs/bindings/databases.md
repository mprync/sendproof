# Verified framework and database combinations

The [conformance manifest](../../tests/conformance/bindings.json) lists the exact framework, provider and database combinations exercised over HTTP. Each count shows the passing and total checks for that combination. A dash indicates a combination outside the verified matrix.

| Framework and provider | SQLite | PostgreSQL | MySQL | MariaDB | SQL Server | H2 |
| --- | --- | --- | --- | --- | --- | --- |
| ASP.NET Core and EF Core | 24/24 | — | 11/11 | 11/11 | — | — |
| Treasury example | 7/7 | — | — | — | — | — |
| Express, Fastify, Hono and NestJS with Node SQLite | 11/11 each | — | — | — | — | — |
| Express and Drizzle | 11/11 | 11/11 | 11/11 | 11/11 | — | — |
| Express and Knex | 11/11 | 11/11 | 11/11 | 11/11 | 11/11 | — |
| Express and TypeORM | 11/11 | 11/11 | 11/11 | 11/11 | — | — |
| Express and Prisma | 11/11 | 11/11 | 11/11 | 11/11 | — | — |
| FastAPI and SQLAlchemy | 25/25 | — | — | — | — | — |
| Django Ninja and Django ORM | 25/25 | — | — | — | — | — |
| Flask and SQLAlchemy | 25/25 | — | — | — | — | — |
| Flask-SQLAlchemy | 25/25 | 25/25 | 25/25 | 25/25 | — | — |
| Spring Boot and JPA/Hibernate | — | — | 14/14 | 14/14 | — | 25/25 |
| Ktor and JDBC | — | — | — | — | — | 25/25 |
| Go net/http with database/sql | 11/11 | 11/11 | 11/11 | 11/11 | 11/11 | — |
| chi, Gin and Echo with database/sql | 11/11 each | — | — | — | — | — |
| Go net/http and GORM | 11/11 | 11/11 | 11/11 | 11/11 | 11/11 | — |
| Laravel and Eloquent | 11/11 | — | 11/11 | 11/11 | 11/11 | — |
| Symfony and Doctrine | 11/11 | — | — | — | — | — |
| Rails and ActiveRecord | 11/11 | 11/11 | 11/11 | 11/11 | — | — |
| Axum and Actix Web with SQLx | 11/11 each | 11/11 each | 11/11 each | 11/11 each | — | — |

The MariaDB entries run the same fixtures as the MySQL ones against the `mariadb` Compose service (MariaDB 12.3, the current long-term-support series), including the shared `secret-columns`, `raw-commit` and `mysql-escape` rules. Each fixture reaches MariaDB through the driver it uses for MySQL, except Spring Boot (`jdbc:mariadb`, MariaDB's own driver, because MySQL Connector/J failed to start Hibernate against MariaDB 12.3 in this setup) and Laravel (its `mariadb` driver). The runner gives the fixture `BENCH_DATABASE=mysql` and `BENCH_DATABASE_SERVER=mariadb`, so a fixture that has to tell the two apart can.

Frameworks can use another provider from their ecosystem. The table identifies the combinations tested together. See each provider's guide for automatic row capture, per-statement behavior, concurrency and limits.

## Concurrent previews on MySQL and SQLite run one at a time

On MySQL and MariaDB, each provider (including the EF Core, Spring JPA and Ktor JDBC providers) lets one preview run at a time in each process, and further previews wait their turn. InnoDB checks a new key for duplicates under a shared lock. When three or more transactions insert the same key and the first one rolls back, as every preview does, InnoDB aborts all but one of the rest with a deadlock (error 1213), at any isolation level. Sent for real, the first insert would commit and the others would get a duplicate-key error. SQLite previews already queue the same way, because each one opens with `BEGIN IMMEDIATE` (Django included). Previews sent to different processes or servers of one application still run at the same time, so they can still hit this deadlock. (PHP serves requests in separate worker processes, so its turn is a file lock that orders the Previews of every process on the host.) When that happens, the preview fails safely and nothing is written. Sends and observed sends never wait for a turn.

## Local test coverage

| Suite | SQLite | PostgreSQL | MySQL | SQL Server | Shared or H2 |
| --- | --- | --- | --- | --- | --- |
| Node core and shared assets | — | — | — | — | 17 |
| Express, Fastify, Hono, NestJS | 13, 15, 11, 10 | — | — | — | — |
| Node SQLite | 11 | — | — | — | — |
| Node batch-two stores (guard only) | — | — | — | — | Cassandra 7 and OpenSearch 7 against the `heavy-stores` Compose services (skipped when down); Elasticsearch and OpenSearch 7 more, Cosmos DB 10 and Firestore 11 over fake servers and recordings; classifiers 11 |
| PHP batch-two stores (guard only) | — | — | — | — | OpenSearch 5 against the `heavy-stores` Compose service (skipped when down); Elasticsearch 9 and OpenSearch (PSR-18 and legacy transports) 33 over a fake transport, run again with the layout checks on Elasticsearch 8 (36, the 9-only bulk-helper test skips); Firestore 42 over a fake gax transport and the recordings (8 read-only replay variants skip) and 1 over a real gRPC channel (needs `ext-grpc`); 3 class-layout checks; Laravel 5 and Symfony 1 wiring tests. Cassandra and Cosmos DB are unsupported |
| Knex | 15 | 15 | 15 | 15 | 2 |
| Drizzle | 10 | 21 | 12 | — | 2 configuration, 10 PGlite |
| TypeORM | 9 | 10 | 9 | — | 10 |
| Prisma | 11 | 11 | 12 | — | 15 |
| Flask-SQLAlchemy | 14 | 14 | 14 | — | — |
| Go database/sql and GORM | 27 | 27 | 27 | 26, 1 skipped | 2 |
| Go batch-two stores (guard only) | — | — | — | — | Cassandra 8 against the `heavy-stores` Compose service (skipped when down); Elasticsearch and OpenSearch 16 (one against the `heavy-stores` service, the rest over fake clusters, including two-node pool, retry and bulk-indexer checks); Cosmos DB 12 and Firestore 13 over fake servers and recordings; classifiers 3. The five main Go conformance entries run the Cassandra and OpenSearch checks |
| Rails ActiveRecord | 42, 4 skipped | 42, 4 skipped | 45, 1 skipped | — | — |
| SQLx | 8 | 10 | 11 | — | 22 unit |

Other local suites passed as follows:

- **.NET, 163:** ASP.NET Core 55, EF Core 58 (the MySQL regression test and the EF MongoDB provider test need the compose services and skip without them), data stores 48 (13 Redis, 11 DynamoDB and 24 MongoDB, against the compose services and skipping without them) and Treasury 2.
- **Python, 306:** core 207 (69 of them data-store tests for MongoDB, Redis and DynamoDB, which need the compose services and skip without them, and 100 classifier, guard and pipeline tests), FastAPI 24 (9 data-store), Django 21 (7 data-store), Flask 39 (13 data-store, and 14 extension tests on SQLite) and SQLAlchemy 15. The PostgreSQL and MySQL extension runs are listed separately above.
- **JVM, 196:** core 56, Spring Boot 46, JPA 13, Ktor 17, JDBC 12, MongoDB 30, Redis 12 and DynamoDB 10. The MongoDB, Redis, DynamoDB and Spring Data tests need the `mongodb`, `redis` and `dynamodb` Compose services and skip when they are down. The Spring MySQL run uses the same fixture with `BENCH_DATABASE=mysql`.
- **PHP, 450:** core 241 (data-store tests for MongoDB, Redis and DynamoDB, which need the compose services and skip without them, and the batch-two tests in the table above), Laravel 109 (38 data-store tests that need the services, an emulated-prepares check on MySQL, the MySQL turn, the transaction-control checks, 12 SQL Server tests and the batch-two wiring), Symfony 64 (12 of them SQL Server) and the Elasticsearch 8 run 36. The Laravel MySQL, MariaDB and SQL Server conformance entries run the fixture with eight workers, so their concurrent-Preview check exercises the turn. The SQL Server tests (start savepoint, `SET IMPLICIT_TRANSACTIONS OFF` allowed and `ON` refused, a commit around the guards, an `XACT_ABORT ON` error and a deadlock victim refusing every later statement) need the `sqlserver` Compose service and the `pdo_sqlsrv` extension, and skip without either. The MySQL escape, deadlock and turn tests also pass on MariaDB when `BENCH_MYSQL_URL` names it.

On MariaDB the local suites pass against the `mariadb` Compose service: Node 318 (`BENCH_MYSQL_URL` pointing at it), PHP all three suites as counted above, Flask-SQLAlchemy 14 (its capabilities test expects the provider to report `mariadb`), SQLAlchemy and Django 46, Ruby ActiveRecord, the Go example engines, and the Java JDBC and JPA escape tests, which run on MariaDB's own driver when `BENCH_DATABASE_SERVER=mariadb`. The manifest's MariaDB entries run these through `--local-tests`.
- **Ruby, 270:** core 190 (data-store tests among them: classifiers, MongoDB, Mongoid, Redis and DynamoDB, which need the compose services and skip without them), ActiveRecord 46 (listed above for SQLite, PostgreSQL and MySQL), Rails 26 and the Rails fixture 8.

The Rails ActiveRecord suite skips the four MySQL-only tests (concurrent-insert deadlock, `CALL` and implicit commits, deadlock refusal, committed-anyway) on SQLite and PostgreSQL, and on MySQL the bound-parameter test, which has no prepared statements through Trilogy. The Go counts exclude parent tests that group subtests. The SQL Server case for a single-statement upsert is skipped because SQL Server uses `MERGE`, which is outside keyed capture. The Go packages also pass vet, race checks and the 15 module-path rewrite tests. The Rust workspace includes 82 local tests in total.

## Run database conformance

Start the required services using the digest-pinned [Compose file](../../tests/conformance/compose.yml). CI starts the matching service automatically. SQLite and H2 fixtures don't need a database server.

```sh
docker compose -f tests/conformance/compose.yml up -d --wait postgres mysql mariadb
export BENCH_POSTGRES_URL='postgresql://bench:bench_local@127.0.0.1:55432/postgres'
export BENCH_MYSQL_URL='mysql://root:bench_local@127.0.0.1:53306/mysql'
export BENCH_MARIADB_URL='mysql://root:bench_local@127.0.0.1:53307/mysql'
npm ci --prefix tests/conformance
node tests/conformance/run.mjs --database postgresql
```

For SQL Server, add the `sqlserver` Compose service and set `BENCH_SQLSERVER_URL` to `mssql://sa:BenchLocal_2026%21@127.0.0.1:51433/master?encrypt=false&trustServerCertificate=true`. Its image targets Linux amd64.

The `php-laravel-sqlserver` entry reaches SQL Server through the `sqlsrv` and `pdo_sqlsrv` PHP extensions on Microsoft's ODBC driver, which the repository doesn't bundle. Install it under Microsoft's licence terms. On macOS: `brew tap microsoft/mssql-release https://github.com/Microsoft/homebrew-mssql-release`, then `HOMEBREW_ACCEPT_EULA=Y brew install msodbcsql18 mssql-tools18`, then build the two extensions for your PHP (`pecl` may not find them; download the `sqlsrv` and `pdo_sqlsrv` source packages from pecl.php.net, run `phpize`, `./configure` and `make`, and enable them in a `conf.d` file). The driver loads OpenSSL 3 from `/opt/homebrew/opt/openssl/lib`, so that link must point at `openssl@3`, not a later major version. In CI the entry installs `msodbcsql18` from Microsoft's apt repository on the Ubuntu runner and gets the extensions from `setup-php`.

Prepare the selected fixtures using their manifest commands. The credentials above are specific to the disposable local services. The runner creates and drops a fresh database for each fixture process, so the service account needs permission to do both. Server-backed profiles confirm the committed row and the absence of rolled-back rows through a separate database connection.
