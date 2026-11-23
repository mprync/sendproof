# Sendproof for Go

Mount the Sendproof workbench inside a Go API. A developer signs in, picks an operation from the OpenAPI document and edits a typed request. **Preview** runs an eligible operation inside a database transaction and returns its response, the row changes and the recorded side effects, then rolls everything back. **Send** runs the ordinary request, optionally with a trace.

The workbench is the same prebuilt UI used by every Sendproof binding. It is embedded in the module with `go:embed`, so consumers need neither Node nor a second list of endpoints.

| Module | Package | Purpose |
| --- | --- | --- |
| `…/adapters/go` | `sendproof` | Core and `net/http`: workbench, discovery, Preview transport, observed Send, traces, effects, `slog` capture. Standard library only. |
| `…/adapters/go` | `dbsql` | `database/sql` provider for SQLite, PostgreSQL, MySQL and SQL Server: transaction enlistment, savepoints, SQL capture and redaction, per-statement row changes. Standard library only. |
| `…/adapters/go/chi` | `chisendproof` | Route marker for [chi](https://github.com/go-chi/chi). |
| `…/adapters/go/gin` | `ginsendproof` | Route marker for [Gin](https://github.com/gin-gonic/gin). |
| `…/adapters/go/echo` | `echosendproof` | Route marker for [Echo](https://echo.labstack.com) v4. |
| `…/adapters/go/gorm` | `gormsendproof` | [GORM](https://gorm.io) connection pool on top of `dbsql`. |

The framework and GORM adapters are separate modules, so an application only downloads the ones it imports. They require the core module at a released version (`v0.1.0-alpha.1` today). No `go.mod` contains a `replace` directive; [`go.work`](go.work) resolves those versions to this checkout for local development. See [Modules, versions and the module path](#modules-versions-and-the-module-path).

## Quick start

```go
db, _ := dbsql.Wrap(sqlDB, dbsql.WithDatabaseLabel("inventory_dev")) // engine detected from the driver

bench, err := sendproof.New(
	sendproof.WithEnvironment("Development"),
	sendproof.WithProvider(db.Provider()),
	sendproof.WithPrincipal(principalFromSession),
)

mux := http.NewServeMux()
bench.HandlePreview(mux, "POST /items", http.HandlerFunc(createItem)) // eligible for Preview
mux.HandleFunc("GET /items/{id}", getItem)                            // Send only

http.ListenAndServe(":8080", bench.Middleware(mux))
```

Open `/sendproof/`. A runnable version is in [`examples/quickstart`](examples/README.md). Run `go run ./quickstart` from `adapters/go/examples`.

`bench.Middleware` must wrap the whole application, outside the router and its authentication, so a preview is routed, authenticated and authorized exactly like the real request.

## What a handler must do

A preview is only as complete as the handler's enlistment. For a marked route:

1. **Run every query through the `dbsql.DB` wrapper** with the request context (`db.ExecContext(r.Context(), …)`). The wrapper routes the request's queries to one transaction during a preview and to the pool otherwise. A raw `*sql.DB` or `*sql.Tx` bypasses it and is neither rolled back nor shown. Nested `db.BeginTx` becomes a savepoint, so the application's own commits and rollbacks keep working inside the preview.
2. **Record external effects at their dispatch boundary** and skip them when told to:

   ```go
   if !sendproof.RecordEmail(ctx, "Stock notice", from, to, subject, text) {
       send(...) // a preview returns true: record only
   }
   ```

   `RecordEffect`, `RecordHTTP`, `RecordJob` and `RecordMessage` follow the same pattern. An observed Send records the effect as `delivered: true` and returns false.
3. **Log with the request context** through a handler wrapped by `sendproof.SlogHandler(next)` (`logger.InfoContext(ctx, …)`), or call `sendproof.Log(ctx, level, message)`.

Mark a route only when its whole request path meets this boundary. Preview is not a sandbox: caches, files, other databases and calls to other services need their own handling.

An unmarked route is never run by Preview: the transport answers `409` before dispatch. The `dbsql` wrapper also refuses writes during a preview that has no session, so a handler that forgot its marker fails closed.

## Frameworks

Routers match a request before middleware runs, so wrap the **router** with `bench.Middleware`, then mark each route with the framework's own marker. Pass the full route path, including any group prefix, because a marker cannot see it.

```go
// chi
r.With(chisendproof.Preview(bench, http.MethodPost, "/items/{id}")).Post("/items/{id}", create)

// Gin
r.POST("/items/:id", ginsendproof.Preview(bench, http.MethodPost, "/items/:id"), create)

// Echo
e.POST("/items/:id", create, echosendproof.Preview(bench, http.MethodPost, "/items/:id"))

http.ListenAndServe(addr, bench.Middleware(router)) // r, engine or e
```

Place authentication middleware **before** the marker, so an unauthenticated preview is rejected before a transaction begins.

For another router, call `bench.Operation(method, path)` once per route and use `Enter(w, r)` before the handler and `Complete(r)` after it. `Wrap` and `Middleware` do this for `net/http`.

## GORM

```go
wrapped, _ := dbsql.Wrap(sqlDB)
gdb, _ := gorm.Open(sqlite.Dialector{Conn: gormsendproof.NewPool(wrapped)}, &gorm.Config{})
// or postgres.New(postgres.Config{Conn: …}), mysql.New(mysql.Config{Conn: …}), sqlserver.New(sqlserver.Config{Conn: …})

gdb.WithContext(r.Context()).Create(&item) // WithContext carries the request into the pool
```

GORM reaches the preview transaction only through `WithContext`. GORM's own transactions become savepoints during a preview, and its statements are captured by the same mechanism as hand-written SQL, so no model registration is needed. GORM expands named SQL arguments into positional ones, so parameter names appear as `$1`, `$2`; redaction then applies per statement.

## Path base

The workbench, discovery links, sign-in URLs and redirects all honor a mount prefix. Strip it with `StripPathBase`, which also records it for `sendproof.PathBase(r)`:

```go
handler := sendproof.StripPathBase("/tenant", bench.Middleware(mux))
// Requests outside /tenant receive 404; handlers build links with sendproof.PathBase(r).
```

When a reverse proxy strips the prefix before the request reaches Go, declare it with `sendproof.WithPathBase("/tenant")` instead. Request paths seen by the application never contain the base.

## Preview sessions and journeys

With Sendproof enabled, `dbsql` and GORM support Preview sessions automatically. The workbench opens a session for the signed-in subject or an anonymous caller and sends its ID with each Preview. Keep using the request context for store calls. Mark previewable writes as usual. Within a session, GET operations can read earlier steps' uncommitted changes unless explicitly marked unavailable. Call `bench.Close()` during shutdown before closing the clients or database pools.

A session holds one transaction per rollback-capable store. It admits one request at a time, expires after five idle minutes or thirty minutes total, and rolls back on end. Each subject can open four sessions, with sixteen per process. Use sticky routing on multi-instance hosts. [Store limits](data-stores.md#preview-sessions) describes lock and lifetime differences.

### Define journeys in Go

Pass the JSON OpenAPI handler you serve at `WithOpenAPIURL` to `WithCodeJourneys`. `New` calls it at startup to check operation IDs. Invalid journeys fail startup in Development. Other environments log and skip them.

```go
type lookupInputs struct {
	ID string `json:"id,omitempty" jsonschema:"default=sample-item"`
}

// Use the same openAPI handler for GET /openapi.json and this option.
bench, err := sendproof.New(
	sendproof.WithProvider(provider),
	sendproof.WithOpenAPIURL("/openapi.json"),
	sendproof.WithCodeJourneys(openAPI, sendproof.JourneyDocument{
		ID: "items", Name: "Item journeys",
		Journeys: []sendproof.Journey{{
			ID: "lookupItem", Name: "Look up an item", Inputs: lookupInputs{},
			Steps: []sendproof.JourneyStep{{
				ID: "lookup", OperationID: "getItem",
				Parameters: []sendproof.JourneyParameter{{Name: "id", In: "path", Value: sendproof.Input("id")}},
				SuccessCriteria: []sendproof.JourneyCriterion{sendproof.StatusIs(http.StatusOK)},
				ExpectWrites: &sendproof.StepWrites{},
			}},
		}},
	}),
)
```

`json` tags name the inputs and mark optional fields with `omitempty`. Use `jsonschema` tags for defaults and descriptions. Bind a later request to a named `Outputs` expression with `sendproof.StepOutput(step, name)`. `StepWrites` describes store writes, effects and approved differences. Set `SendOnlyReason` if a journey must commit. Redis writes are automatically Send-only.

Run journeys with the Sendproof CLI in CI against a test instance. For the example above, seed `sample-item` or pass a JSON input file with `--inputs`. Provide a development persona or an auth header if the API requires authentication.

```sh
npx --package @sendproof/cli sendproof journeys run lookupItem \
  --api http://127.0.0.1:8080 --mode preview --junit journeys.xml
```

Use `--all` to run every journey. Preview rolls back the run. To run a Send-only journey on a disposable test instance, use `--mode send --allow-send --yes`.

### Register file journeys

Register authored Arazzo JSON and a sibling expectations file using an embedded filesystem or `os.DirFS`:

```go
//go:embed journeys/*.json
var journeyFiles embed.FS

// Include this option in sendproof.New.
sendproof.WithJourneys(journeyFiles, "journeys/store.arazzo.json")
```

Provide `journeys/store.expect.json` alongside the Arazzo file. Use app-relative paths such as `/openapi.json` in the Arazzo source descriptions. Sendproof adds the request's path base when serving the document and advertises both URLs under `/sendproof/journeys/`.

## Row changes

`dbsql` needs no table registration. It runs each previewed or observed request on a dedicated connection and captures row changes **per statement, in execution order**, with the real before and after rows and the row's primary key. The engine is detected from the `database/sql` driver; `WithDialect` overrides it.

| Engine | Driver tested | Preview | Observed Send |
| --- | --- | --- | --- |
| SQLite | `modernc.org/sqlite` | Pre-update hook on the preview connection: every row change, including triggers, foreign-key actions and `REPLACE`. Tables without a primary key are keyed by `rowid`. | Same hook, with the commit and rollback hooks deciding which events were kept. |
| PostgreSQL | `github.com/jackc/pgx/v5/stdlib` | Audit table and row triggers created inside the preview transaction and rolled back with it: every row change, including triggers and foreign-key actions, in causal order. | Keyed capture. |
| MySQL | `github.com/go-sql-driver/mysql` | Keyed capture. | Keyed capture. |
| SQL Server | `github.com/microsoft/go-mssqldb` | Keyed capture, with `OUTPUT INSERTED` for generated keys. | Keyed capture. |

**Keyed capture** reads the affected rows by primary key around each single-table `INSERT`, `REPLACE`, `UPDATE` or `DELETE`, on the same connection and inside the same transaction. `UPDATE` and `DELETE` first select their `WHERE` rows with a locking read (`FOR UPDATE`, or `UPDLOCK, HOLDLOCK`); inserts take keys from `VALUES`, `LAST_INSERT_ID` stepped by the session's `auto_increment_increment`, an added `OUTPUT INSERTED` or an added `RETURNING`; upserts read the named keys first. The rows stay locked until the transaction ends, so the rows read back are the statement's own result. It cannot see rows changed by triggers or foreign-key actions, statements of other shapes (joins, `INSERT … SELECT`, `MERGE`, procedures), prepared statements or tables without a primary key. Those cases set `changesTruncated` and add a warning log to the trace that names the reason.

**Concurrency.** The capture connection serves only the request, so other requests' writes never appear. An observed Send runs each autocommit statement in its own transaction, the equivalent of autocommit, so its locking reads are isolated too. The one exception, a write that returns rows (such as `INSERT … RETURNING`) outside a transaction under keyed capture, is labeled with a trace warning. During a PostgreSQL preview the audit triggers hold `SHARE ROW EXCLUSIVE` locks, so concurrent writes to the database's tables and other previews wait until the preview ends; Preview answers `503` when it cannot take the locks within five seconds. Reads are never blocked.

Updates that leave a row unchanged are not reported. No table size makes Preview unavailable, because nothing reads whole tables; the trace still keeps at most 200 changes and sets `changesTruncated` beyond that, and keyed capture keeps at most 201 keys per statement. Statements outside an application transaction in an observed Send that is inside one go to the pool, as they would without Sendproof, and are not captured.

### Preview safety

- A preview refuses statements that could end its transaction with `dbsql.ErrUnsafeStatement`: `COMMIT`, `ROLLBACK`, `BEGIN`, MySQL statements that commit implicitly (DDL, `LOCK TABLES`, `SET autocommit` and others), SQL-level `PREPARE` and `EXECUTE` on MySQL, and procedure calls on MySQL (`CALL`) and SQL Server (`EXEC`). Use `BeginTx` for application transactions; it runs them on savepoints. Declare MySQL procedures that never commit with `dbsql.WithSafeProcedures("name", "schema.name")` (exact names, no wildcards). **Warning:** a declared procedure that does commit keeps the handler's writes; the preview still fails.
- After a MySQL deadlock or a SQL Server deadlock victim (or any failure that leaves no transaction open), the database has rolled the preview back: every later statement of that preview is refused, including a write whose capture read hit the deadlock, and the preview answers 500.
- Every preview sets the savepoint `sendproof_preview` when it starts and rolls back to it before the final rollback (on SQL Server, `SAVE TRANSACTION` and `ROLLBACK TRANSACTION`). Any commit erases it, even one the guard never saw, so a missing savepoint fails the preview with 500, also when a new transaction opens after the commit (MySQL `autocommit=0`, SQL Server `IMPLICIT_TRANSACTIONS ON`). A handler may not set, release or roll back to that savepoint. On SQL Server, `SET IMPLICIT_TRANSACTIONS OFF` is allowed and `ON` is refused.
- SQLite's commit hook and a PostgreSQL deferred guard trigger turn any commit that still reaches the database into a rollback. MySQL and SQL Server previews check after a failed statement that the transaction is still open (a deadlock or severe error rolls it back), and stop with an unconfirmed preview if it is not.
- A PostgreSQL preview runs each statement outside an application transaction on a savepoint, so a failed statement is undone alone, as with autocommit, instead of aborting the rest of the request.

Drivers without named parameters (pgx, MySQL) receive `sql.Named` values positionally; the name still drives redaction. Other data layers implement `sendproof.Provider`.

## Data stores

MongoDB (driver v2), Redis (go-redis v9), DynamoDB (AWS SDK for Go v2), Cassandra (gocql v2), Elasticsearch and OpenSearch (go-elasticsearch 8, opensearch-go 4), Cosmos DB (azcosmos) and Firestore (the gRPC client) are covered only through the clients you hook, and only for calls made with the request's context; a store write sent without one while a Preview is open fails that Preview with 500. [Data stores in the Go binding](data-stores.md) covers setup, the `preview: false` mark and what each store does in a Preview.

## Authentication and policy

The application owns authentication. Supply:

- `WithPrincipal(func(*http.Request) (Principal, bool))` for the identity shown in the workbench and the owner of traces. A trace is readable only by the same `Subject` and `Scheme` under the same path base; every other caller receives `404`.
- `WithAuthProvider(label, kind, url)` for the sign-in methods to advertise, such as `cookie` (password JSON form), `personas` or `oidc`. URLs are local paths and receive the path base.
- `WithAccessPolicy(func(*http.Request) bool)` to restrict the workbench, Preview and traces (`401` when anonymous, `403` otherwise).

The workbench and Preview are on only in the environments named by `WithEnabledEnvironments` (default `Development`). The current environment comes from `WithEnvironment`, then `SENDPROOF_ENVIRONMENT`, `APP_ENV` or `GO_ENV`, and defaults to `Production`, so nothing is exposed until you opt in.

## Capture, redaction and retention

| Setting | Behavior |
| --- | --- |
| Limits | 500 logs, 100 effects, 200 changes, 32 log properties, 64 SQL parameters; truncation is reported with `logsTruncated`, `effectsTruncated` and `changesTruncated`. A preview response over 1 MiB is rejected with `413`. |
| SQL values | Shown only in `Development` unless `WithSQLParameterValues(true)`. A value is `[REDACTED]` when its parameter name is secret-like (`password`, `token`, `secret`, `hash`, `salt`, `api_key`…), matched by whole word. If a statement text names a secret, all of that statement's values are redacted, because positional placeholders carry no column names. Other statements keep their values. |
| Traces | Kept for five minutes (`WithTraceTTL`), eight per owner, 32 in total. `WithClock` lets tests advance time. |

## Security properties

- Preview needs exactly `Prefer: tx=rollback` and the reserved `/sendproof/_preview/…` URL. Cross-site browser requests, `HEAD`, redirects, path traversal and a target inside `/sendproof` are rejected.
- A preview is confirmed only after the provider rolls back and closes. A failed rollback, a panicking handler or an unmarked route yields a non-confirming problem response, never an envelope. The database stays unchanged.
- The inner response never sets cookies, redirects the client, or forwards `Set-Cookie`, `Location` and hop-by-hop headers.

## Building and testing

The repository does not require a system Go. These scripts install a pinned, SHA-256-verified toolchain under `artifacts/` and run `go` with its caches there:

```sh
adapters/go/scripts/setup-go.sh                  # download and verify Go 1.26.11 into artifacts/go-toolchain
adapters/go/scripts/go.sh test ./...             # run from adapters/go, chi, gin, echo, gorm or examples
adapters/go/scripts/build-fixture.sh             # build artifacts/go/fixture for the conformance runner
node tests/conformance/run.mjs <binding id>     # protocol conformance
```

The module needs Go 1.24 or newer. The Echo adapter follows Echo's own minimum.

### Updating the embedded UI

`internal/ui/dist` is generated from `ui/` by the shared packer and committed, because Go modules must carry their assets. After a UI change run:

```sh
cd adapters/go && scripts/go.sh generate ./internal/ui
```

`TestEmbeddedUIMatchesItsManifest` fails when a file differs from `manifest.json`.

## Modules, versions and the module path

Thirteen Go modules live here: core (`.`, which holds `sendproof`, `dbsql` and `stores`), `chi`, `gin`, `echo`, `gorm`, the store hooks `redisbench`, `dynamobench`, `mongobench`, `cassandrabench`, `searchbench` (Elasticsearch and OpenSearch), `cosmosbench` and `firestorebench`, and the unpublished `examples`, plus the `tools/modzip` release helper.

**Local development.** Every sibling requirement in a `go.mod` names a real version, so a published module never needs editing. [`go.work`](go.work) lists the modules in `use` and maps exactly those versions to the checked-out directories in a `replace` block, so everything builds, vets and tests before anything is tagged. Without that block Go asks the module proxy for the unpublished versions as soon as two modules select different third-party versions. `go.work` is never part of a module zip and consumers ignore it. `go get` is not available in workspace mode and a plain `go mod tidy` cannot see the unpublished versions, so run:

```sh
adapters/go/scripts/tidy.sh [module ...]   # import the new package first; writes clean go.mod and go.sum files
```

`tidy.sh` tidies a temporary `go.tidy.mod` that carries the local mappings and writes the result back without them. It needs network access.

**The module path.** [`MODULE_PATH`](MODULE_PATH) records the one authoritative module base. It is a placeholder until the repository location is known. Then run, from the repository root:

```sh
node tools/set-go-module-path.mjs github.com/your-org/your-repo --dry-run   # list the files it would change
node tools/set-go-module-path.mjs github.com/your-org/your-repo
adapters/go/scripts/tidy.sh && adapters/go/scripts/test.sh
```

The argument is the repository's import path; the base becomes `<repository>/adapters/go`. The tool replaces the old base at whole-path boundaries in `go.mod`, `go.work`, `*.go`, `*.md` and `MODULE_PATH` under `adapters/go` and in nothing else: not `go.sum`, `go.work.sum`, the embedded UI or any file outside `adapters/go`. It checks first that the new path is a valid module path, that reversing the rewrite reproduces every original file, that no unmanaged file names the old base and that no `go.mod` has a `replace`; any failure changes nothing. `node tools/set-go-module-path.mjs --check` verifies the tree without rewriting (`node --test tests/go/set-go-module-path.test.mjs` runs its tests).

### Releasing

Pass the version of the release, for example `v0.1.0-alpha.1`. Releases tag the eight public modules together at the same version:

```sh
adapters/go/scripts/package.sh v0.1.0-alpha.1    # checks metadata, UI, vet/race tests; writes zips, tags.txt, SHA256SUMS to artifacts/go-packages
adapters/go/scripts/tags.sh v0.1.0-alpha.1       # the git tags to create
adapters/go/scripts/verify-release.sh v0.1.0-alpha.1
```

`package.sh` refuses to continue when a `go.mod` has a `replace`, when an internal requirement is not at the release version (update the requirements and the `go.work` replace block together, then run `tidy.sh`) or when the committed embedded UI is stale. A module in a subdirectory is released by a tag named `<subdirectory>/<version>`, so the tags are `adapters/go/vX`, `adapters/go/chi/vX`, `adapters/go/gin/vX`, `adapters/go/echo/vX`, `adapters/go/gorm/vX`, `adapters/go/redisbench/vX`, `adapters/go/dynamobench/vX`, `adapters/go/mongobench/vX`, `adapters/go/cassandrabench/vX`, `adapters/go/searchbench/vX`, `adapters/go/cosmosbench/vX` and `adapters/go/firestorebench/vX`. `tags.sh` fails when a module path is not the repository path plus its directory, because such a tag could never resolve. Tag the core module first and wait until the proxy serves it, because the others require it.

`verify-release.sh` works on a copy under `artifacts/go-release-check`, retargets it to a placeholder repository path and then checks that a fresh consumer module outside the repository, with `GOWORK=off` and an empty module cache, can import the five framework and core modules and serve the embedded workbench (the store modules are packaged and served by the same proxy). It does this twice: from the module zips through a file-backed module proxy, and from a local git repository carrying the real tags, which proves the tag names resolve. It needs network access for third-party dependencies and does not publish anything.
