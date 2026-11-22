# Journeys

A journey is an ordered set of operations a person performs to finish a task, such as taking an order through to shipment. Each step's outputs feed the next. Sendproof runs a journey through the screens it already generates, one step at a time or all at once, with Preview or with a real Send, and compares what each step wrote with what it should have written. A difference passes only when it cites an approved-difference record.

Sendproof owns the format, the screens and the runner. Each API publishes its journeys as data, the way it publishes its OpenAPI document. The mocks are in [`mocks/`](../../mocks/README.md#v7-journeys) behind `?v7=1`.

## Decisions

- **Journeys are Arazzo.** The OpenAPI Initiative's Arazzo Specification 1.1.0 (17 May 2026) describes workflows, steps, inputs, outputs and success criteria over an OpenAPI document. We read it as published and add nothing to it.
- **Everything Sendproof adds lives in a companion document**, the expectations document, next to the Arazzo document: the writes each step should make, the persona each step runs as, and the approved differences. The Arazzo document stays portable to other Arazzo tools.
- **Simple journeys are inferred** from OpenAPI `links` when an API publishes no Arazzo document. They carry no expectations until someone records them.
- **Recordings stay out.** A product that wants to turn its own recordings into journeys writes a converter in its own repository that emits Arazzo and an expectations document. Sendproof only reads the format.

## What Arazzo 1.1 can and can't express

It can: workflows with JSON Schema `inputs`; steps that call an `operationId` (or `operationPath`, or another workflow); `parameters` and `requestBody` built from runtime expressions (`$inputs.quantity`, `$steps.createOrder.outputs.orderId`, `$response.body#/id`); `successCriteria` (simple, regex, JSONPath, XPath); `onSuccess` and `onFailure` actions (`end`, `goto`, `retry` with `retryAfter` and `retryLimit`); step and workflow `outputs`; `dependsOn` between workflows and, new in 1.1, between steps; reusable `components`; AsyncAPI sources (new in 1.1); and `x-` extensions.

It can't: say what a step should write to a database or document store, which side effects it should hold or send, who the step runs as (only as a header or cookie value), whether to Preview or Send, which differences are approved, or how to clean up after a run that sent for real. The companion covers the first four. Clean-up is an open question.

## The model

| Thing | What it is | Where it lives |
| --- | --- | --- |
| Journey | An Arazzo workflow: `workflowId`, summary, description, `inputs`, `steps`, `outputs` | Arazzo document |
| Step | One operation call: `stepId`, `operationId`, `parameters`, `requestBody`, `successCriteria`, `outputs` | Arazzo document |
| Input binding | A parameter or body value written as a runtime expression. The step's screen shows it pre-filled with where it came from ("From step 1 · `orderId`") | Arazzo document |
| Expected writes | Per step: the rows, documents, items and keys it should change, the effects it should hold or send, its persona, and what to do with writes nobody listed | Expectations document |
| Approved difference | A reviewed record that allows one known difference: which journey, step, store, table or collection and field, the expected and actual values, why, who approved it, when, and when it expires | Expectations document |
| Run | One attempt at a journey: mode (Preview or Send), inputs, persona, start time, each step's request and result | Browser storage, or a file from the CLI |
| Result | Per step: the response, the captured changes, the comparison with each finding, and the approved differences it used. Per run: the verdict and timings | Inside the run |

### The expectations document

One JSON file per Arazzo document. Steps are keyed by `workflowId` and `stepId`. Values are literals, runtime expressions (strings starting with `$`), or one of three matchers: `{ "type": "date-time" }` for generated values, `{ "pattern": "^JD\\d{12}$" }`, and `{ "from": …, "to": … }` on updates.

```json
{
  "sendproofExpectations": "1.0",
  "arazzo": "store.arazzo.json",
  "ignore": [{ "store": "sqlite", "table": "__EFMigrationsHistory" }],
  "journeys": {
    "orderToShipment": {
      "steps": {
        "shipOrder": {
          "persona": "ada.admin@acme.dev",
          "writes": [
            { "store": "sqlite", "table": "Orders", "op": "update",
              "key": { "Id": "$steps.createOrder.outputs.orderId" },
              "values": { "Status": { "from": "Paid", "to": "Shipped" }, "ShippedAt": { "type": "date-time" } } },
            { "store": "sqlite", "table": "Shipments", "op": "insert",
              "values": { "OrderId": "$steps.createOrder.outputs.orderId", "Carrier": "DHL",
                          "ServiceLevel": "$inputs.shippingMethod", "TrackingNumber": { "pattern": "^JD\\d{12}$" } } },
            { "store": "sqlite", "table": "StockReservations", "op": "delete",
              "key": { "OrderId": "$steps.createOrder.outputs.orderId" } },
            { "store": "mongodb", "collection": "orders", "op": "update",
              "key": { "orderId": "$steps.createOrder.outputs.orderId" },
              "values": { "status": { "from": "Paid", "to": "Shipped" } } }
          ],
          "effects": [{ "kind": "email", "to": "$inputs.customerEmail", "subject": { "pattern": "shipped" } }],
          "unlisted": "fail"
        }
      }
    }
  },
  "approvedDifferences": [{
    "id": "AD-0011",
    "journey": "orderToShipment", "step": "shipOrder",
    "target": { "store": "sqlite", "table": "Shipments", "field": "Carrier" },
    "kind": "value", "expected": "DHL", "actual": "DHL Express",
    "reason": "The carrier catalog renamed DHL to DHL Express in 2.1. Expectations still say DHL until they're re-recorded.",
    "approvedBy": "sam.support@acme.dev", "approvedOn": "2026-11-12", "expires": "2026-12-31",
    "link": "https://github.com/acme/store-api/issues/412"
  }]
}
```

- `writes: []` means the step must write nothing. With Arazzo `successCriteria` of `$statusCode == 409`, that's an expected refusal.
- `unlisted` is `fail` by default. A change to a table or collection that isn't listed is reported as extra. Tables that change on every request, such as migration history, go in `ignore`, which the API's author declares and reviews. An approved difference can't be used to ignore a table.
- `kind` is `value`, `missing` or `extra`. A record covers a finding only when the journey, step, target and kind match, `expected` and `actual` match when given, and it hasn't expired. An expired record covers nothing, and the run says it expired.
- The workbench never approves anything. On a finding it offers **Draft approved difference**, which copies a record for the author to commit. The approval is the code review of that commit.

## Discovery

Capabilities gain an optional `journeys` array. Each entry names an Arazzo document and its expectations document, on the same origin and mount as `openApiUrl`:

```json
"journeys": [{ "name": "Store journeys", "arazzoUrl": "/sendproof/journeys/store.arazzo.json", "expectationsUrl": "/sendproof/journeys/store.expect.json" }],
"previewSessions": true
```

An adapter serves files the API's author registers (`.WithJourneys("journeys/store.arazzo.json")` in .NET). A framework adapter can later write Arazzo from route annotations, as it writes OpenAPI today. Each Arazzo `sourceDescriptions` entry must resolve to a document in `documents`; a step whose operation isn't in it, or that targets an AsyncAPI source, is shown as "Not run by Sendproof".

Without `journeys`, Sendproof infers journeys from OpenAPI `links` (a response link from Start cart's 201 to Get cart, carrying `$response.body#/id`). Inferred journeys sit in their own sidebar group, run like any other, and offer **Record expected writes** after a clean Preview, which copies an expectations document to commit.

## Running a journey

A run picks its mode when it starts.

- **Preview run.** Every step previews inside one held Preview session, so step 3 sees the order step 1 created, and nothing is ever written. This needs a protocol addition: `POST /sendproof/_api/sessions` opens a session; each Preview carries `Sendproof-Session: <id>`; the adapter keeps one transaction per store that can roll back, on one pinned connection, with a savepoint before each step so a step can be re-run; `DELETE` on the session, an idle limit or the run's end rolls everything back. Sessions belong to the caller, like traces, and take one request at a time. Capabilities say `previewSessions: true`. A step that writes to a guarded store (Redis, DynamoDB) blocks the run at that step, as a single Preview blocks today.
- **Send run.** Every step is sent for real with Observed Send (`Prefer: trace`), so its writes can still be compared. Before sending a step you can Preview it on its own, against what the earlier steps committed. A Send run asks once at the start ("This run writes to `store-demo.db` in Development") and is offered by default only when the environment is Development. Without `observedSend`, writes are "Not checked" and only Arazzo's criteria are checked.

Step by step, each step opens its own generated screen with its bound values filled in. Each bound value shows where it came from and can be changed before running; the run records the change. **Run to end** runs the remaining steps in the run's mode.

A run stops when a step is refused unexpectedly, fails its `successCriteria`, or is blocked. Arazzo's `onFailure` actions are honoured: `retry`, `goto` and `end`. Write mismatches don't stop a run by default; they're recorded and the run carries on. Stopping at the first mismatch is an option. When a Send run stops, the summary lists what earlier steps left in the database, with links to the operations that would undo them.

## Comparing and reporting

After each step, Sendproof matches each expected write to a captured change by store, table or collection, operation and key, then compares field by field. Each expected write or effect gets one finding:

| Finding | Meaning |
| --- | --- |
| Match | Written as expected |
| Differs | Written, but one or more fields have other values. The diff shows expected beside actual, field by field |
| Missing | Expected, but nothing like it was written |
| Extra | Written, but not expected (with `unlisted: fail`) |
| Approved | A difference that an approved-difference record covers, shown with the record's ID, reason and expiry |
| Not checked | Couldn't be compared: no trace, a store Sendproof didn't hook, or capture truncated |

A step passes when every finding is Match or Approved and its `successCriteria` hold. It reads "Passed · 1 approved difference" when a record was used. The run summary lists every step with its verdict, mode and time, the approved differences used, those that were unused or expired, and exports: the run as JSON, and JUnit XML for CI. Captures in a run are redacted as Preview and traces are today; a run never holds cookies or `Authorization` headers.

## The agent-facing runner

The same runner ships as a CLI and as an MCP server, so QA agents and CI run journeys exactly as people do.

```sh
npx sendproof journeys list --api http://127.0.0.1:5189/sendproof
npx sendproof journeys run orderToShipment --mode preview --inputs inputs.json --out run.json --junit report.xml
npx sendproof journeys run orderToShipment --mode send --yes        # send for real; refused outside Development
```

Exit code 0 means passed, 1 failed, 2 couldn't run. Sign-in uses `--persona <email>` (the personas source), `--cookie-jar` or `--header`.

`sendproof mcp --api <url>` is an MCP server over stdio. The client sends `initialize` with its protocol version, capabilities and `clientInfo`. The server answers with `capabilities: { tools: { listChanged: true } }` and `serverInfo`. The client sends `notifications/initialized`, then calls `tools/list` and `tools/call`. Each tool has an `inputSchema` and an `outputSchema` and returns `structuredContent` with a one-line text summary. A failed step is a normal result; a tool that can't run returns `isError: true`.

| Tool | Does |
| --- | --- |
| `list_journeys` | Journeys with their step count, inputs and last result |
| `describe_journey` | Steps, bindings, expected writes and the inputs' JSON Schema |
| `start_run` | `{ journeyId, mode, inputs }`. Send needs `confirmSend: true` and the server started with `--allow-send` |
| `run_step` | `{ runId, stepId?, action: "preview" \| "send", overrides? }`. Returns the step's response and findings |
| `run_remaining` | Runs to the end or the first stop; returns the summary |
| `get_run` | The whole run |
| `end_run` | Ends a run and rolls back its Preview session |
| `draft_approved_difference` | `{ runId, stepId, findingId, reason }`. Returns a record to propose; never writes a file |

## Open questions

1. **Held Preview sessions.** Holding a transaction across requests pins a connection, holds locks between steps, and needs sticky routing when the API runs on more than one instance. MongoDB aborts a transaction after 60 seconds by default (`transactionLifetimeLimitSeconds`), so a step-by-step Preview over MongoDB may need a longer limit in development, or a fast **Run to end**. The alternative is replay: Preview step N by re-running steps 1 to N in one request, which holds nothing but makes every adapter evaluate Arazzo expressions, and generated IDs change on every replay. I recommend held sessions.
2. **Personas within one session.** A step that runs as another persona (a moderator publishing a review) changes the principal mid-session. Should a session allow persona switches through the personas source only?
3. **Matching several similar rows.** When a step inserts several rows with no key in the expectations, we match them in order. Is that enough, or do authors need a `match` field list?
4. **Clean-up after a Send run.** Arazzo has nothing for it. Should the companion name a clean-up journey per journey?
5. **One file or two.** Approved differences have their own review and expiry. Should they live in their own file so a change to expectations and an approval never share a commit?
6. **Nested workflows.** Arazzo steps can call other workflows. Show them inline in the rail, or as one step that opens the inner journey?
7. **The store example** needs a `links` section and an Arazzo document so the inferred and authored cases both have real data. That's `examples/StoreApi`'s change to make, after the mocks are approved.
