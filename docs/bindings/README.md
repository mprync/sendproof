# Framework bindings

Each binding serves the OpenAPI workbench from the API at `/bench/`. The workbench loads the API's existing OpenAPI document and calls the host's own authentication and request pipeline. A data provider supplies rollback and captures changes for operations the host explicitly makes eligible for Preview.

| Runtime | Frameworks | Rollback provider |
| --- | --- | --- |
| .NET | [ASP.NET Core](../../adapters/dotnet/TestBench.AspNetCore) | [Entity Framework Core](../../adapters/dotnet/TestBench.EntityFrameworkCore) |
| Node.js | [Express, Fastify, Hono and NestJS](../../adapters/node) | Node SQLite, Drizzle, Knex, TypeORM and Prisma |
| Python | [FastAPI, Django and Flask](../../adapters/python) | SQLAlchemy and Django ORM |
| JVM | [Spring Boot and Ktor](../../adapters/java) | JPA/Hibernate and JDBC |
| Go | [net/http, chi, Gin and Echo](../../adapters/go) | database/sql and GORM |
| PHP | [Laravel and Symfony](../../adapters/php) | Eloquent and Doctrine |
| Ruby | [Rails](../../adapters/ruby) | ActiveRecord |
| Rust | [Axum and Actix Web](../../adapters/rust) | SQLx with SQLite, PostgreSQL and MySQL |

The [conformance manifest](../../tests/conformance/bindings.json) identifies the exercised fixture and runtime for each combination. Each package's README defines which database operations it can track.

## Configure an application

1. Enable the binding in a development environment. Add an application access policy for hosted environments.
2. Keep the same-origin OpenAPI route you already serve. Set the document URL if it differs from the binding default.
3. Connect the binding to the app's authenticated identity and sign-in routes. Supply a stable identity subject to enable observed Send.
4. Set up the transaction provider and mark buffered operations whose writes all participate in that transaction. Suppress external effects at their dispatch boundary. Other operations still support ordinary Send.

See the [configuration mapping](options.md) and [verified database combinations](databases.md). For a new ecosystem, follow the [binding implementation checklist](adding.md).

## Run the same checks locally

Use Node.js 22.14 or newer for the runner. Prepare the binding with its manifest's `prepare` command. Install the runner's dependencies and select one or more binding IDs.

```sh
npm ci --prefix tests/conformance
node tests/conformance/run.mjs --list
node tests/conformance/run.mjs node-express dotnet-aspnetcore
```

Run without IDs to check all prepared bindings. The runner starts fixtures on loopback, runs actual HTTP requests, and stops each fixture on completion. Use `--port-offset <number>` when running alongside another local matrix. The CI workflow reads the same manifest to create the verification matrix.

Use `--database` to select one engine and `--local-tests <binding-id>` to run its registered suite with the same database setup as CI. Server-database fixtures need the local services described in the database guide.
