# Binding progress

## 2026-11-20

### Node and Express

Implemented the Node core, Express middleware and a SQLite provider. Express passed 11 of 11 HTTP conformance checks on Node 24.5.0. The three Node unit checks passed, including an overlapping ordinary write and a rejected write from an expired SQLite transaction scope. Preview currently depends on configured SQLite row keys for change capture.

### Node and Hono

Implemented the Hono middleware and fixture against the shared SQLite provider. All 11 HTTP conformance checks passed. Hono runs on the Node runtime and uses the shared core and UI.

### Node and Fastify

Implemented the Fastify plugin and fixture, with route-level opt-in. All 11 HTTP conformance checks passed and the local in-process regression passed. Next on Node is the NestJS binding and package archive verification.

### Node and NestJS

Implemented `TestBenchModule.forRoot()` and a controller action decorator for the NestJS Express adapter. All 11 HTTP conformance checks passed, including native Nest guards on rewritten requests. The module uses the existing Swagger JSON route and discovers eligible controller actions from metadata.

### Drizzle

Implemented a Drizzle SQLite query builder integration that shares the enrolled SQLite connection. Express with Drizzle passed all 11 HTTP conformance checks with ORM-generated mutations. Positional bindings are redacted and callers supply the keys of tracked rows.

### Knex

The request-local Knex transaction provider passed 11 of 11 checks against real SQLite. A local regression verifies that a missing rollback acknowledgment stays unconfirmed even when the rollback call resolves. Changes are captured by selected primary keys.

### TypeORM

TypeORM and the `better-sqlite3` driver passed 11 of 11 checks. The provider selects the request EntityManager, serializes SQLite connection leases and records changes for selected keys.

### Prisma

Prisma 7.10.1 with the Better SQLite driver adapter passed all 11 HTTP checks. The provider checks the physical rollback and driver completion separately from the callback failure, and a local regression covers a release without rollback acknowledgment. The fixture client is generated locally from its Prisma schema.

### ASP.NET Core and the reference example

The disposable ASP.NET Core/EF Core fixture passed 11 of 11 HTTP conformance checks. The reference example profile passed 7 of 7, including independent reads of payments and balances around Preview and Send. Generic rejection, rollback-failure and asset coverage moved to the conformance runner. All 49 .NET tests passed after the migration. The in-process tests still cover model binding, delayed rollback, endpoint policy, and provider availability.

### FastAPI

FastAPI and the SQLAlchemy provider passed 11 of 11 HTTP checks. The local Python suites passed 67 tests across framework and provider packages. Wheels and source distributions were built, including the shared UI manifest in the core wheel. Only SQLite was exercised for SQLAlchemy.

### Django

The Django middleware and ORM provider passed 11 of 11 HTTP checks with a Django Ninja OpenAPI fixture. Django REST Framework can supply the configured OpenAPI route. DRF document generation and async Django views remain unverified.

### Flask

The Flask middleware and SQLAlchemy provider passed 11 of 11 HTTP checks. Flask-SQLAlchemy integration remains unverified.

### Spring Boot

Spring Boot and the Hibernate/JPA provider passed 11 of 11 HTTP checks. The JVM suite passed 79 tests after adding Ktor and the Spring builder. Tests cover builder precedence, deployment gating, independent transactions and autocommit writes. Bulk writes and raw JDBC are captured as SQL. Entity events supply row changes.

### Ktor

The Ktor plugin and JDBC transaction provider passed all 11 HTTP checks on JDK 17 against H2. The Kotlin DSL configures the same core protocol and shared UI.

### Laravel

Laravel and Eloquent passed 11 of 11 HTTP checks. The PHP core and Laravel packages passed 49 and 22 local tests respectively.

### Symfony

Symfony with Doctrine passed 11 of 11 HTTP checks against relational SQLite and passed 24 local tests. The Composer release builder verified the core archive includes the generated UI manifest and excludes vendor files and tests. Captured row changes cover tracked Doctrine entities. Raw DBAL and DQL statements appear as SQL.

### Rails

The Rails engine, Rack core and ActiveRecord provider passed 11 of 11 HTTP checks and 119 local tests. All three gems built and the core gem contains the generated UI.

### Go net/http, chi, Gin, Echo and GORM

The five Go profiles passed all 55 HTTP checks. Vet and race-detector tests passed across the Go modules. A file-backed module proxy served the core release archive to a fresh consumer, which served the embedded UI. The local build used Go 1.26.11. Framework release modules still use local replacement directives.

### Axum

Axum and the SQLx SQLite provider passed 11 of 11 HTTP checks and 32 workspace tests. SQLite's pre-update hook captures triggered and bulk writes. The SQLx provider is SQLite-specific.

### Actix Web

The Actix Web adapter shares the SQLx SQLite provider with Axum and passed 11 of 11 checks. The final Rust workspace passed 41 tests and Clippy. The core crate packaged and compiled with its UI assets. PostgreSQL, MySQL, Diesel and SeaORM providers remain unimplemented.

### Full matrix

The final run passed all 271 tests across 25 manifest entries with zero failures or skips. Each standard fixture passed 11 tests. The reference example passed its seven profile tests. The matrix covers real HTTP transport, schema validation, authorization, independent rollback and commit checks, trace ownership and expiry, and capture limits.

Local test totals include 49 .NET, 8 Node, 67 Python, 79 JVM, 95 PHP, 119 Ruby and 41 Rust tests, plus Go vet and race-detector suites. The Node consumer type check passed for the framework packages and Prisma. The CI workflow passed Actionlint. Go and Gradle used project-local toolchains or wrappers.

## 2026-11-20 Database and TypeScript follow-up

### Node core and web frameworks

Ported the core, Express, Fastify, Hono and NestJS to strict TypeScript with generated declarations. Core protocol and transaction-scope tests passed 16, Express 13, Fastify 15, Hono 11 and NestJS 10. Core trace tests cover scheme and mount isolation, eviction, timing and expiry. Framework suites cover real routing, body parsing, route authorization and bounded response streams.

### TypeORM

The strict TypeScript provider discovers keys through entity metadata. All 38 local tests and 33 HTTP checks passed across SQLite, PostgreSQL and MySQL, with direct reads of the server databases. A savepoint keeps failed inspection reads from breaking application writes on PostgreSQL. Tests also cover disposal on a shared SQLite query runner. Documented bounds apply to automatic snapshots, cross-table triggers and concurrent writers during observed Send.

### Flask-SQLAlchemy

The extension-backed fixture passed 11 HTTP checks per database on SQLite, PostgreSQL and MySQL. The runner confirmed persistence against the two server databases independently. The extension suite has 13 tests per database, and the aggregate Python suite includes the extension tests.

### Database-aware runner

Added manifest database selectors, CI service containers, disposable databases for each fixture, and independent durable-state reads. Verified create/drop against PostgreSQL 17.12, MySQL 8.4.13 and SQL Server 2022 Developer locally. SQL Server runs in an emulated amd64 Docker container on this workstation.

### SQLite and Knex

The TypeScript SQLite provider keeps nested writes inside Preview with savepoints and passed 11 local tests. The TypeScript Knex provider discovers primary-key columns from the database and uses the builder's conditions to find update and delete targets. Generated keys come from driver results or `returning()` where supported. Knex passed 15 local tests per database (SQLite, PostgreSQL, MySQL and SQL Server) plus 2 rollback acknowledgment tests. The final Knex SQL Server fixture passed 11 of 11 HTTP checks. Large or unidentifiable writes set `changesTruncated`. Raw SQL appears in the SQL log.

### Prisma

The Prisma 7 schema generator supplies model, relation and key metadata to the TypeScript provider. Prisma's SQLite, PostgreSQL and MySQL profiles passed 11 HTTP checks each and 49 local tests in total. The verified local tests include composite and generated keys, bounded bulk capture, nested transactions, physical rollback and blocking implicit commits or writes through a pooled root connection. The workspace generates metadata for three example schemas with the compiled generator. Package archives expose the generator as a bin.

### Go modules and release tooling

The checked-in workspace replaces local module directives. `adapters/go/MODULE_PATH` names the current import prefix and `tools/set-go-module-path.mjs` updates it before release. The rewrite tool passed 15 tests. The release tools built five Go modules, verified their tags and served the embedded workbench in a fresh consumer with `GOWORK=off`. The Go module prefix still needs the repository's final GitHub location.

### Drizzle

The Drizzle provider uses the primary key in the table definition and supports generated and composite keys. It captures statement-ordered changes, drops changes undone by savepoints and omits its inspection queries from the SQL log. Passed 55 local tests and 11 HTTP checks each on SQLite, PostgreSQL and MySQL. The local tests also exercised PGlite and both PostgreSQL drivers. MySQL uses the enrolled connection's current auto-increment interval and marks unsupported generated-key statements incomplete.

### Rust SQLx

Axum and Actix Web passed 11 HTTP checks each on SQLite, PostgreSQL and MySQL. The Rust workspace passed 82 tests, including 8 SQLite, 10 PostgreSQL and 11 MySQL SQLx integration tests. PostgreSQL temporary audit triggers capture statements in order with savepoint semantics and isolate observed Send by session. MySQL uses locking primary-key reads and marks potentially missed writes from visible triggers and cascading foreign keys as incomplete. PostgreSQL Preview holds locks while it runs. SQL Server has no SQLx profile.

### Go database/sql and GORM

The providers discover tables and primary keys automatically. SQLite uses connection hooks, PostgreSQL Preview uses a transaction-local audit, and MySQL, SQL Server and PostgreSQL observed Send use locking primary-key reads. There is no table-size rejection. The final race run passed 136 named tests, including parent tests, with one SQL Server `MERGE` case skipped. All 11 Go HTTP profiles passed 121 checks after the auto-increment fix. The five module archives also packed successfully against the final sources. Keyed capture reports incomplete changes for unsupported statement shapes and indirect writes.

### Full database matrix

The full run passed 513 of 513 checks across 47 profiles, with no failures or skips. Each standard profile passed 11 checks. The reference example passed 7. Final targeted reruns passed 33 HTTP checks for Drizzle, 22 for Rust MySQL and 121 for Go. A clean Node workspace install built all ten packages, generated all three Prisma clients, passed `tsc --noEmit`, and produced ten archives containing ESM and generated declarations. The final Node local suite passed 281 tests. Actionlint and Compose configuration checks passed.
