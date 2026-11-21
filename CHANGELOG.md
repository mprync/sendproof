# Changelog

## Unreleased

First prerelease of Test Bench. The two .NET NuGet packages share the same version.

- Serve the workbench from `/bench`, discover host authentication and render typed forms from OpenAPI.
- Preview opted-in minimal API and MVC routes with a relational EF Core transaction. Inspect tracked rows and application-reported side effects before deciding to send.
- Capture scoped structured logs, redacted EF Core commands, request timing and typed effects. Add optional owner-only observed Send traces to protocol v1.
- Use examples, identity-aware lookups, command search, request history and redacted request exports.
- Edit requests in a responsive Form or JSON builder with field-level validation, Autofill and a headers grid with presets and variables. Press `?` for the keyboard shortcut directory or `⌘K` to search commands on macOS.
- Inspect JSON responses with search and schema matching, follow related operations, and view captured database changes, timing, side effects, logs and headers when available.
- Workbench v3 design: a larger default scale (14 px text, 36 px controls) with Compact and Comfortable densities, an API overview landing page, a Docs view for every operation (press D), a Models sidebar tab with property trees, compositions and discriminators, and a Schema view of each response.
- Every result tab is always available and explains itself before a run, after a 401 and when Send isn't traced. Traced Send is on by default in Development.
- Field toggletips from the spec, a per-field Generate menu with valid values within the schema and deliberately invalid ones, random Autofill values that say where they came from, specific validation messages, and Code snippets with typed placeholders for missing values.
- Visible copy feedback everywhere, with an inline notice and the text selected when the clipboard is blocked.
- Sign-in explains failures: a 401 is "Wrong email or password", a 5xx says what to try and shows the technical details. The page has a way back to the workbench.
- Localised interface in English, German and Arabic (right to left), with `Intl` numbers, dates, units, lists and plurals, Latin or Arabic-Indic digits, and platform shortcut glyphs. Captured data is always shown exactly as stored.
- The Treasury example keeps its cookie keys beside its database (`treasury-demo.keys/`), so sign-in no longer depends on the machine-wide key ring, and documents its security, roles and error responses in OpenAPI.
- Workbench v4 navigation: one stable three-column shell for Try it, Docs, Models and the overview; breadcrumbs and a single Back control (⌥←) with real hash routes, history and scroll restoration; sidebar groups that start open and are remembered per API; a signed-out notice with lock markers; one property-row anatomy with inline `$ref` and `oneOf` expansion; and JSON that opens fully expanded.
- Extend the workbench through the framework protocol, preview provider interfaces and field renderer registration.
- Run the Treasury example with a seeded SQLite database.
- Pack the shared workbench UI as a versioned SHA-256 bundle for language packages.
- Run the same protocol conformance checks over HTTP across bindings, with a separate profile for the Treasury example.
- Add Express, Fastify, Hono and NestJS bindings backed by the shared Node core, with SQLite, Drizzle, Knex, TypeORM and Prisma providers.
- Add FastAPI, Django and Flask bindings with SQLAlchemy and Django ORM providers.
- Add Spring Boot with JPA/Hibernate, Ktor with JDBC, Go with database/sql and GORM, Laravel with Eloquent, Symfony with Doctrine, Rails with ActiveRecord, and Axum and Actix Web with SQLx.
- Build the Node bindings from strict TypeScript with ESM, generated declarations and public-API type checks.
- Exercise each listed framework and database combination with isolated fixture databases, database services in CI and separate connections that verify rollback and commit.
- Discover primary keys automatically in Drizzle, Knex, TypeORM and Prisma. Verify these providers against SQLite, PostgreSQL and MySQL, and Knex against SQL Server.
- Capture Go database/sql and GORM writes per statement on SQLite, PostgreSQL, MySQL and SQL Server. Use native capture or primary-key reads and report incomplete capture without rejecting large tables.
- Remove Go's table registration API. Applications can remove `Track`, `WithTable` and `WithMaxTrackedRows` from their provider setup.
- Add PostgreSQL and MySQL rollback and row capture to Rust SQLx for Axum and Actix Web.
- Verify Flask-SQLAlchemy on SQLite, PostgreSQL and MySQL. Use a Go workspace for local module development and verify release artifacts from a fresh Go consumer.

The [release guide](docs/releasing.md) covers package registration, verification and publication.
