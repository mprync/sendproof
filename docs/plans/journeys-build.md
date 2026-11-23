# Journeys: build plan

The design is [journeys.md](journeys.md); the approved screens are the v7 mocks (`mocks/v7-journeys.js`, `mocks/v7.css`, `mocks/README.md` "v7: journeys"). This page fixes the contracts the parts share, so they can be built in parallel. The .NET adapter proves the whole design; the other eight adapters follow on the same protocol afterwards.

## Parts

| Part | Owns | Depends on |
| --- | --- | --- |
| A. Preview sessions | Protocol text in `spec/README.md`, the .NET implementation in `Sendproof.AspNetCore`, `Sendproof.EntityFrameworkCore` and `Sendproof.MongoDB`, their tests | This page |
| B. Journeys in .NET | `Sendproof.Journeys` (the typed builder, Arazzo and expectations generation, serving, startup validation), `Sendproof.Journeys.Generators` (the `StoreOperations` source generator), `Sendproof.Journeys.Testing`, journeys in `examples/StoreApi`, tests | This page, A for capabilities only |
| C. Journey engine | `ui/journeys/` (pure ES modules, no DOM): runtime expressions, step binding, success criteria, write comparison, approved differences, run model, JUnit, its tests | This page |
| D. Workbench | Journeys mode in `ui/` exactly as the v7 mocks, every locale | C, A |
| E. Runner | `sendproof journeys list|run` in `@sendproof/cli`, the MCP run tools | C, A |
| F. End to end | The store example running journeys in the browser, the CLI and an MCP client | All |

## Contract 1: Preview sessions (protocol v1, additive)

Capabilities gain `"previewSessions": true` when the adapter supports them.

- `POST {mount}/_api/sessions` opens a session. Same admission as Preview (same-origin rules, workbench policy, Preview enabled). Answers `201 { "id": "<≥122 random bits, hex>", "idleTimeoutSeconds": 300, "maxLifetimeSeconds": 1800 }` with `Cache-Control: no-store`. A session belongs to the caller's stable subject when authenticated; an anonymous caller's session is reachable only with its ID.
- A Preview carrying `Sendproof-Session: <id>` runs inside the session: every store that can roll back keeps one transaction for the whole session, on one pinned connection, so a later step sees an earlier step's uncommitted rows. Before each step the adapter takes a savepoint. The envelope is the normal Preview envelope, with `changes`, `effects` and `logs` for that step only, plus `"session": { "id": "…", "step": <n> }` where `n` counts from 1. `rolledBack: true` still means nothing was committed.
- `POST {mount}/_api/sessions/{id}/rewind` with `{ "step": n }` rolls back to the savepoint before step `n`; steps `n` and later are discarded and the next Preview is step `n`. `204`.
- `DELETE {mount}/_api/sessions/{id}` rolls everything back and ends it. `204`. Idle timeout, maximum lifetime and host shutdown do the same.
- Errors are RFC 9457 problems with a `code`: `session_not_found` (404: unknown, expired, foreign), `session_busy` (409: a session takes one request at a time), `session_failed` (409: a store ended the transaction, such as MongoDB's 60-second transaction limit; the session is then closed and rolled back). A blocked write (`preview_unavailable`, 409) rolls back to that step's savepoint and leaves the session usable.
- Effects stay held per step, as in a single Preview. A held SQLite write transaction blocks other writers until the session ends; idle timeout bounds that.

**Changes (part A, .NET).** The protocol text is [spec/README.md, Preview sessions](../../spec/README.md#preview-sessions). Additions to the contract above:

- `429` with `code: "session_limit"` when the caller has four open sessions or the host sixteen. A signed-in caller without one stable subject gets `403` from `POST /_api/sessions`; rewinding past the next step gets `400`.
- A failed handler and any other refused step roll back to the step's savepoint and leave the session usable, as a blocked write does. A step that succeeded but left the transaction unusable (a PostgreSQL error the handler caught) is rolled back too and answers 500. A step whose held transaction can't be vouched for closes the session with a plain 500; `session_failed` stays for a store that ended the transaction on its own.
- Every relational EF Core provider holds sessions: SQLite, PostgreSQL, MySQL and MariaDB (Oracle's `MySql.EntityFrameworkCore`, the only MySQL provider for EF Core 10; EF Core generates the savepoint SQL itself where MySql.Data has none) and SQL Server, all through EF Core's savepoint API. SQL Server can't release a savepoint, so a kept step there proves the transaction is still the session's by `CURRENT_TRANSACTION_ID()`. A MySQL or MariaDB session keeps the process's Preview turn until it ends, so other MySQL Previews wait and a second session can't open (it fails after 5 seconds). `previewSessions` is `false` only for the MongoDB EF Core provider, which has no savepoints; MongoDB through the driver is covered on a replica set.
- MongoDB has no savepoints: its "savepoint before each step" is each step's before images, written back inside the transaction to undo or rewind.
- Inside a session a Preview may run any `GET`, marked or not, in the session's transaction (approved follow-up), so read steps see earlier steps' rows. `preview: false` operations stay refused; other methods still need `previewOperations`; nothing changes outside a session. `HEAD` stays refused, as for every Preview, because the envelope needs a body.
- A session belongs to the identity that opened it: sign in or switch persona before opening one. Switching identity mid-session makes it foreign (`404 session_not_found`).

## Contract 2: discovery of journeys

Capabilities gain `"journeys": [{ "name": "Store journeys", "arazzoUrl": "/sendproof/journeys/store.arazzo.json", "expectationsUrl": "/sendproof/journeys/store.expect.json", "source": "code" }]` (`source` is `code` or `file`; URLs include any path base). The Arazzo document is Arazzo 1.1.0 with `sourceDescriptions` naming the OpenAPI document by its served URL. The expectations document is the JSON in [journeys.md, The expectations document](journeys.md#the-expectations-document), with these additions:

- Each journey may carry `"group"`, `"runAs"` (persona email), `"sendOnly": true` with `"sendOnlyReason"`, and `"definedIn": { "type": "OrderToShipmentJourney", "file": "Journeys/OrderToShipmentJourney.cs" }`.
- Each step's writes are keyed by `stepId`. A write is `{ "store": "sqlite" | "<capabilities dataStores system>", "table" | "collection" | "key", "op": "insert" | "update" | "delete" | "<store command>", "key": {…}, "values": {…} }`. For SQL, `store` is the capabilities `database.system`; a Preview change with no `store` is the SQL database.
- A value is a literal, a runtime expression string starting with `$`, or a matcher object: `{ "type": "date-time" | "uuid" | "string" | "number" | "integer" | "boolean" | "any" }`, `{ "pattern": "…" }`, `{ "from": <value>, "to": <value> }`.
- `effects` entries match Preview effects: `{ "kind": "email", "to": <value>, "subject": <value> }` and the other conventional kinds' data keys.
- `approvedDifferences` entries as in the design; `"field"` inside `target` is the column, field or key part.

**Changes (part D, workbench).**

- The documents route is `/sendproof/journeys/{name}.arazzo.json` and `…/{name}.expect.json` only. A catch-all `{file}` shadowed the workbench's own engine modules, which it serves from the same folder (`/sendproof/journeys/index.js`), so Journeys mode couldn't load.
- An expected write to a store the host doesn't hook, an expected write to a store a traced Send carried no changes for, and every write after an untraced Send are reported **Not checked** (`kind: 'unchecked'` with a `note`), not Missing; they don't fail the step. The workbench applies this around `recordStep`; part E's runner should do the same.
- Effects match a single expected recipient against a list (an email's `to` arrives as an array), in `compare.js`.
- Runs are kept per API document in `localStorage` (`sendproof-journey-runs:<openApiUrl>`, 20 per journey) as the exported run model plus `by` (who ran it) and `tally` (changes per store and effects).
- **UI fixes from the first end-to-end run (1280 px, dark).** *Priority fitting* (`ui/bar-fit.js`, measured because media queries cannot see the text size): the top bar gives way in a fixed order until nothing wraps or truncates (Specification | Journeys switch to icons, search trigger to its icon, API version, signed-in role, database name; classes `fit-mode`, `fit-search`, `fit-ver`, `fit-role`, `fit-db`), and below 1280 px the switch is icons by media query too; every kept control keeps its title or accessible name. A journey action bar's status line (`statusLine` in `journeys-view.js`) is container-aware: it shows its natural sentence (`jr.bar.*`: "From earlier steps", "Commits for real", "Step 3 stopped the run") when there is room, never wraps or cuts a word, and collapses to its icon when there is none, with the sentence as its `title` (and the text, which stays in the DOM, as its accessible name); if even the icon will not fit beside the buttons, the buttons drop their shortcut hints (`is-tight`). A journeys result bar's note does the same (`.bar-text.is-fit`). The sidebar's Operations | Models tabs drop their side padding below 15rem of tab row and their counts below 11rem. A problem is counted the same everywhere (`findingCounts`: each differing field, each missing or extra write, each unmet criterion), so the rail, chips, verdict, filter and tab flag agree. Rows that pair a name with detail (matched writes, what a stopped Send left, the summary's stores and open findings, approved-difference records, run history) put the detail under the name as a one-line `row-sub`, ellipsized with the whole text in its title. An email finding reads `to a@b.c · subject "…"`, and MongoDB Extended JSON values read as the plain value. A field label is never squeezed below its text: the type, then "optional", then the Fixed or bound chip give way first. An overview input bound to a step field with `x-lookup`, an enum or a format takes that field's control (`inputControls`), so Order to shipment's `customerId` is the customer picker. Send's confirmation is still the browser's `confirm()`, pending the designed dialogs.

## Contract 3: the engine (`ui/journeys/`)

Pure ES modules usable by the browser and Node (no DOM, no fetch). The workbench and `@sendproof/cli` both import them; the CLI copies them into its package at build.

```js
// expressions.js
evaluate(expression, context)            // $inputs.x, $steps.id.outputs.x, $response.body#/ptr, $response.header.Name, $statusCode, $request.*; literals pass through
interpolate(value, context)              // deep: strings that are whole expressions are evaluated; "{$expr}" inside strings is substituted
// steps.js
bindStep(step, context)                  // → { path, query, headers, body, bound: [{ target, expression, value, from: 'input' | 'step' | 'fixed', stepId? }] }
checkCriteria(criteria, response)        // → [{ condition, passed, actual }]; supports ==, !=, <, <=, >, >=, &&, || and simple JSONPath/pointer operands
stepOutputs(step, response)              // → { name: value }
// compare.js
compareStep({ expected, changes, effects, context, approved, ignore, unlisted, store, clock }) // → { verdict, findings }
// finding: { id, kind: 'match'|'differs'|'missing'|'extra'|'approved'|'unchecked', store, target, op, key, fields: [{ name, state, expected, actual, source, record? }], record?, note? }
// verdict: 'passed' | 'passed-approved' | 'failed'
// run.js
createRun({ journey, expectations, mode, inputs, persona, store, clock }) // the run model below
recordStep(run, stepId, { response, envelope, durationMs })  // binds outputs, checks criteria, compares writes
exportRun(run) / toJUnit(run)
```

The run model (also the JSON export, the CLI's `--out` and the MCP `get_run` result): `{ runId, journeyId, name, mode: 'preview'|'send', status: 'running'|'passed'|'failed'|'stopped', startedAt, finishedAt, durationMs, persona, inputs, steps: [{ stepId, operationId, status: 'pending'|'passed'|'failed'|'refused'|'blocked'|'skipped', httpStatus, durationMs, startMs, criteria, outputs, findings, verdict, bound }], approvedUsed: [id], approvedUnused: [id], approvedExpired: [id] }`. A run stops at a step that is refused unexpectedly, fails its criteria or is blocked; write differences don't stop it.

### Libraries

Nothing here reimplements an Arazzo tool; each module is glue over a maintained library, plus the one thing none of them do: compare captured writes against Sendproof's own expectations document.

- **`expressions.js`** resolves runtime expressions over [`@swaggerexpert/arazzo-runtime-expression`](https://github.com/swaggerexpert/arazzo-runtime-expression) (Apache-2.0: parses, validates, extracts and interpolates the expression grammar) and [`@swaggerexpert/json-pointer`](https://github.com/swaggerexpert/json-pointer) (Apache-2.0: evaluates the `#/a/b` suffix on `$request.body`/`$response.body`). Neither library knows what a Sendproof run context (`inputs`, `steps`, `request`, `response`) looks like, so `expressions.js` is only a resolver over their parsed trees.
- **`steps.js`** uses the same two libraries for binding, and [`jsonpath-rfc9535`](https://github.com/P0lip/jsonpath-rfc9535) (Apache-2.0) for the `jsonpath` success-criteria type. The `simple` criteria grammar (`==`, `!=`, `<`, `<=`, `>`, `>=`, `&&`, `||`) is hand-written: it's Arazzo's own small boolean grammar, distinct from a runtime expression, and no package parses it. `xpath` criteria always report unmet: no vendored library reads XML, and the store example is JSON-only.
- **`compare.js`** and **`run.js`** are entirely Sendproof's own: comparing captured changes and effects against the expectations document, approved differences, the run model and its exports are not an Arazzo concern. `toJUnit` is hand-written too; the one maintained browser-safe JUnit writer checked, `junit-report-builder` (MIT), imports `node:fs`/`node:path`/`make-dir` at its top level and won't bundle for the browser.
- **`@redocly/respect-core`** (MIT) is the maintained Arazzo *runtime* — `prepareRequest`, `runStep`, `checkCriteria`, `runWorkflow`, plus a `run()` that takes a custom `fetch`. It would cover more of `steps.js` directly, but it depends on `@redocly/openapi-core`, which imports `node:fs`, `node:path` and `tty` even from its `./runtime-expressions` sub-export, so it can't bundle for a browser with no server behind it. **Part E ended up not using it**: see its Changes below.

`ui/vendor/` holds the three browser bundles (built by `tools/vendor-journeys-libs.mjs`, `npm run vendor-journeys-libs --prefix tools`), about 107 KB minified / 30 KB gzipped together; see [its README](../../ui/vendor/README.md) for exact sizes and versions.

### Changes

- `compareStep` and `createRun` take a `clock` (default the real clock), to age approved-difference records; the contract above didn't carry one through explicitly. `createRun` also takes `store` (default `"sqlite"`), the SQL system id expectations use for store-less changes, since nothing else in its listed parameters supplies it.
- A finding's `fields` entries, and a whole-write `missing`/`extra` finding, carry an optional `record` (the approved-difference id that covered it); `run.js` reads these to compute `approvedUsed`/`approvedUnused`/`approvedExpired`.

**Changes (part E, Node).** `@sendproof/cli` uses `ui/journeys/` (and `ui/vendor/`) as its only journey runtime, not `@redocly/respect-core`: identical results between the CLI, the MCP server and the workbench matter more here than the fuller Arazzo coverage respect-core would add, and running journeys from one engine, tested once (in `ui/journeys/`'s own suite), is simpler to keep correct than running the same journey through two different runtimes that could drift. `tools/pack-journeys-engine.mjs` copies `ui/journeys/*.js` (its own tests dropped) and `ui/vendor/*.js` into `dist/engine/journeys/` and `dist/engine/vendor/` at build (`npm run pack-engine`, wired into the workspace's `build` and `test` scripts); `src/engine/journeys/index.d.ts` is a hand-written declaration file at the same path so TypeScript sees the copied module's shapes (JSDoc wasn't an option: the engine's own source has none, and this package doesn't own it to add any). The runner (`journeys-run.ts`) fills a run's `inputs` from the Arazzo `inputs` schema's own `default` keywords before `createRun`, so a run with no `--inputs` still uses the journey's own sensible values (its C# class's property initializers), matching the CLI's documented `--inputs` as optional.

**Two cross-part findings from running part E against the real store**, both fixed in `compare.js` with tests: Redis keys now go through `interpolate`, and MongoDB Extended JSON values (`$date`, `$oid`, `$number…`) compare as the plain values they stand for, in fields and keys alike.
- `compare.js`'s `describeTarget` resolves a Redis-style bare `key` with `resolveScalar` (a whole `"$…"` expression only), not `interpolate` (which substitutes an embedded `{$expr}` inside a longer string). A key written as `RedisKey.Format`'s own documented shape, `"quote:{$steps.priceCart.outputs.quoteId}"`, is compared against the literal unsubstituted template, so it never matches a real captured command and always reports "missing". Reproduces against the store's Price with a coupon journey (Send).
- The store's MongoDB change capture reports a BSON date as MongoDB Extended JSON (`{ "$date": "2026-…Z" }`), not a plain ISO 8601 string; `compare.js`'s `date-time` matcher (`typeof actual === 'string' && DATE_TIME.test(actual)`) never matches it, so every `Match.Any<DateTime>()`-expected MongoDB date field in the store's journeys reports "differs". Reproduces against Order to shipment's `capturePayment` and `shipOrder` steps (their `order_events`/`order_timelines` writes).

## Contract 4: .NET journeys

As in [journeys.md, Defining journeys in code](journeys.md#defining-journeys-in-code): `Journey<TInputs>`, `JourneyBuilder<TInputs>`, `JourneyStep<TRequest, TResponse>`, `Ref<T>`, `Match`, `StepWrites` with `Sql<TDbContext>()`, `Mongo()`, `Redis(name)`, `Email()`, `ApprovedDifference<T>`, `AddJourneys(assembly)`, `AddJourney<T>()`, `WithJourneys(file)`. `StoreOperations` is generated from `Map*` calls with `WithName`, their handler's body parameter and `Produces<T>`. Generated documents are served at the URLs in contract 2 and validated at startup (Development: fail with a list; elsewhere: log and skip).

### Libraries

- **[Bielu.Arazzo.NET](https://github.com/bielu/Bielu.AspNetCore.ApiDescriptions) 3.2.0** (MIT): the Arazzo object model, JSON writer and validator that build and check every workflow, its reader for `WithJourneys` files, and its runtime-expression parser and evaluator in the test runner. It reads and writes Arazzo 1.0 and 1.1. BinkyLabs.OpenApi.Arazzo 1.0.0 (MIT) also supports 1.1 but needs Microsoft.OpenApi 3.11 or later, which can't load beside ASP.NET Core 10's `Microsoft.AspNetCore.OpenApi` (it pins Microsoft.OpenApi below 3.0).
- **Microsoft.OpenApi 2.12.2** (MIT) reads the OpenAPI document in the test runner; **System.Text.Json's `JsonSchemaExporter`** writes the inputs schema; **[Namotion.Reflection](https://github.com/RicoSuter/Namotion.Reflection) 3.5.1** (MIT) reads the inputs' XML comments; **JsonPath.Net** (MIT) evaluates JSONPath criteria; **Microsoft.AspNetCore.Mvc.Testing** runs journeys in memory; **Roslyn's incremental generator API** generates `StoreOperations`.
- The tests validate generated documents against the OpenAPI Initiative's published schema (`https://spec.openapis.org/arazzo/1.1/schema/2026-04-15`, vendored in `tests/Sendproof.Journeys.Tests/Schemas`) with **JsonSchema.Net** 9.7 (MIT).
- Hand-written, because no library covers them: the typed builder, the expectations document, the simple-condition parser and the write comparison in `Sendproof.Journeys.Testing` (the .NET twin of `compare.js`, needed to run journeys inside `dotnet test`).

### Changes

- **Capabilities and routes.** `Sendproof.AspNetCore` gained an internal `IWorkbenchExtension` (`MapRoutes(app, workbench)`, `AddCapabilitiesAsync`); Sendproof.Journeys registers one to serve `/sendproof/journeys/{file}` and add `journeys`. Part A's session code is untouched.
- **Field and table names.** A SQL write's `table` is the EF Core model's table name (with its schema, as the change capture writes it); its fields are the model's property names, because those are the keys Preview changes report. MongoDB fields are class-map element names; a document class's collection is registered with `journeys.MapCollection<TDocument>("…")`, and a missing one is a startup problem.
- **Where the store entry points live.** `Sql<TDbContext>()` and `Mongo()` are extensions in `Sendproof.Journeys` itself (namespaces `Sendproof.Journeys.EntityFrameworkCore` and `Sendproof.Journeys.MongoDB`), not separate packages, so the package references EF Core Relational and MongoDB.Bson.
- **Criteria literals** are single-quoted, as Arazzo's literal syntax has them: `$response.body#/status == 'Shipped'` (the engine accepts both quotes).
- **Redis writes** are `{ "store": "redis", "key": "quote:{$steps.priceCart.outputs.quoteId}", "op": "SET", "values": { "expiry": { "type": "any" } } }`: refs inside a key are `{$expression}`, and a step's expectations may read its own outputs. A Redis expectation, or a step whose operation is marked `preview: false`, makes the journey `sendOnly`.
- **Effects.** A step's `effects` lists only what it describes (`[]` after `Nothing()`); the .NET runner checks those and doesn't fail other effects. `unlisted` is always `fail`.
- **The store.** The store's API differs from the mocks, so its journeys follow the API: orders take SKUs; `PaymentsController.Capture` (new) captures a bank transfer, making step 3 real; **Ship an unpaid order expects 422**, which is what the store answers for an unpaid order (409 is for a cancelled or shipped one). **AD-0011 relaxes `AuditEvents.Action`** (`Order.Shipped: DHL` → `Order.Shipped: Dhl`), because `Shipments.Carrier` is an enum column that can't hold "DHL Express"; with another carrier as the input, step 4 fails as in the mocks. Price with a coupon checks a coupon, quotes (Redis `SET`) and redeems (Redis `INCRBY`). Without MongoDB or Redis configured, those expectations are reported Not checked.
- **Tests.** `JourneyTestSuite<TEntryPoint>` needs a non-static entry type, so `StoreApplication` is now a sealed class. It sends only with `AllowSend` (for Send-only journeys, or a host without sessions), so the store's `JourneyTests` overrides `AllowSend` and `ConfigureWebHost` to use a throwaway database. The runner signs in as the journey's persona before opening the session, which belongs to the signed-in caller. The test project must reference `Microsoft.AspNetCore.Mvc.Testing` itself, whose build targets record the app's content root.

## Definition of done

- Every part has tests in its own suite; the .NET, Node and UI suites pass.
- The store example publishes at least: Order to shipment (5 steps, SQLite and MongoDB writes, the AD-0011 approved difference, which fails at step 4 as in the mocks when the carrier differs), Cancel before shipping, Ship an unpaid order (expects 409), and Price with a coupon (Send only, Redis).
- The workbench matches the v7 mocks in light, dark, 130% text, Arabic and on a phone.
- F passes: in the built-in browser, run Order to shipment step by step and to the end with Preview, read the result and summary, export JUnit; run a Send-only journey with Send; from an MCP client, list and run a journey and draft an approved difference; from the CLI, run all journeys with JUnit output.
