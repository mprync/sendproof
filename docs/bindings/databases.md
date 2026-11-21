# Verified framework and database combinations

The [conformance manifest](../../tests/conformance/bindings.json) lists the exact framework, provider and database combinations exercised over HTTP. Each count shows the passing and total checks for that combination. A dash indicates a combination outside the verified matrix.

| Framework and provider | SQLite | PostgreSQL | MySQL | SQL Server | H2 |
| --- | --- | --- | --- | --- | --- |
| ASP.NET Core and EF Core | 11/11 | — | — | — | — |
| Treasury example | 7/7 | — | — | — | — |
| Express, Fastify, Hono and NestJS with Node SQLite | 11/11 each | — | — | — | — |
| Express and Drizzle | 11/11 | 11/11 | 11/11 | — | — |
| Express and Knex | 11/11 | 11/11 | 11/11 | 11/11 | — |
| Express and TypeORM | 11/11 | 11/11 | 11/11 | — | — |
| Express and Prisma | 11/11 | 11/11 | 11/11 | — | — |
| FastAPI and SQLAlchemy | 11/11 | — | — | — | — |
| Django Ninja and Django ORM | 11/11 | — | — | — | — |
| Flask and SQLAlchemy | 11/11 | — | — | — | — |
| Flask-SQLAlchemy | 11/11 | 11/11 | 11/11 | — | — |
| Spring Boot and JPA/Hibernate | — | — | — | — | 11/11 |
| Ktor and JDBC | — | — | — | — | 11/11 |
| Go net/http with database/sql | 11/11 | 11/11 | 11/11 | 11/11 | — |
| chi, Gin and Echo with database/sql | 11/11 each | — | — | — | — |
| Go net/http and GORM | 11/11 | 11/11 | 11/11 | 11/11 | — |
| Laravel and Eloquent | 11/11 | — | — | — | — |
| Symfony and Doctrine | 11/11 | — | — | — | — |
| Rails and ActiveRecord | 11/11 | — | — | — | — |
| Axum and Actix Web with SQLx | 11/11 each | 11/11 each | 11/11 each | — | — |

Frameworks can use another provider from their ecosystem. The table identifies the combinations tested together. See each provider's guide for automatic row capture, per-statement behavior, concurrency and limits.

## Local test coverage

| Suite | SQLite | PostgreSQL | MySQL | SQL Server | Shared or H2 |
| --- | --- | --- | --- | --- | --- |
| Node core and shared assets | — | — | — | — | 17 |
| Express, Fastify, Hono, NestJS | 13, 15, 11, 10 | — | — | — | — |
| Node SQLite | 11 | — | — | — | — |
| Knex | 15 | 15 | 15 | 15 | 2 |
| Drizzle | 10 | 21 | 12 | — | 2 configuration, 10 PGlite |
| TypeORM | 9 | 10 | 9 | — | 10 |
| Prisma | 11 | 11 | 12 | — | 15 |
| Flask-SQLAlchemy | 13 | 13 | 13 | — | — |
| Go database/sql and GORM | 27 | 27 | 27 | 26, 1 skipped | 2 |
| SQLx | 8 | 10 | 11 | — | 22 unit |

Other local suites passed as follows:

- **.NET, 50:** ASP.NET Core 30, EF Core 18 and Treasury 2.
- **Python, 80:** core 29, FastAPI 10, Django 8, Flask 20 (including 13 extension tests on SQLite) and SQLAlchemy 13. The PostgreSQL and MySQL extension runs are listed separately above.
- **JVM, 79:** core 30, Spring Boot 27, JPA 9, Ktor 7 and JDBC 6.
- **PHP, 95:** core 49, Laravel 22 and Symfony 24.
- **Ruby, 119:** core 66, ActiveRecord 26, Rails 22 and the Rails fixture 5.

The Go counts exclude parent tests that group subtests. The SQL Server case for a single-statement upsert is skipped because SQL Server uses `MERGE`, which is outside keyed capture. The Go packages also pass vet, race checks and the 15 module-path rewrite tests. The Rust workspace includes 82 local tests in total.

## Run database conformance

Start the required services using the digest-pinned [Compose file](../../tests/conformance/compose.yml). CI starts the matching service automatically. SQLite and H2 fixtures don't need a database server.

```sh
docker compose -f tests/conformance/compose.yml up -d --wait postgres mysql
export BENCH_POSTGRES_URL='postgresql://bench:bench_local@127.0.0.1:55432/postgres'
export BENCH_MYSQL_URL='mysql://root:bench_local@127.0.0.1:53306/mysql'
npm ci --prefix tests/conformance
node tests/conformance/run.mjs --database postgresql
```

For SQL Server, add the `sqlserver` Compose service and set `BENCH_SQLSERVER_URL` to `mssql://sa:BenchLocal_2026%21@127.0.0.1:51433/master?encrypt=false&trustServerCertificate=true`. Its image targets Linux amd64.

Prepare the selected fixtures using their manifest commands. The credentials above are specific to the disposable local services. The runner creates and drops a fresh database for each fixture process, so the service account needs permission to do both. Server-backed profiles confirm the committed row and the absence of rolled-back rows through a separate database connection.
