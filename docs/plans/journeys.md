# Journeys

A journey is an ordered set of operations a person performs to finish a task, such as taking an order through to shipment. Each step's outputs feed the next. Sendproof runs a journey through the screens it already generates, one step at a time or all at once, with Preview or with a real Send, and compares what each step wrote with what it should have written. A difference passes only when it cites an approved-difference record.

Sendproof owns the format, the screens and the runner. Each API publishes its journeys as data, the way it publishes its OpenAPI document. The mocks are in [`mocks/`](../../mocks/README.md#v7-journeys) behind `?v7=1`.

## Decisions

- **Journeys are Arazzo.** The OpenAPI Initiative's Arazzo Specification 1.1.0 (17 May 2026) describes workflows, steps, inputs, outputs and success criteria over an OpenAPI document. We read it as published and add nothing to it.
- **Everything Sendproof adds lives in a companion document**, the expectations document, next to the Arazzo document: the writes each step should make, the persona each step runs as, and the approved differences. The Arazzo document stays portable to other Arazzo tools.
- **Journeys are defined in code.** Typed classes, usually written by an AI agent and reviewed like other code, build the Arazzo document and the expectations at startup (see Defining journeys in code). The same journeys run in the workbench, in `dotnet test`, in CI and through MCP.
- **The workbench doesn't author journeys.** It runs them, explains their results and drafts approved differences. Recording journeys in the UI was designed and dropped: its edge cases (stores Preview can't hold, wrong steps, ambiguous links, which values are inputs, held sessions timing out) put technical decisions on the person recording anyway. A product's own recordings, from other tools, stay out too.
- **Simple journeys are inferred** from OpenAPI `links` when an API publishes no journeys. They carry no expectations; **Copy as C#** on a step's Preview gives the code to add them.

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
- The workbench never approves anything. On a finding it offers **Draft approved difference**, which copies the record as C# (or JSON for file journeys) for the author to commit. The approval is the code review of that commit.

## Discovery

Capabilities gain an optional `journeys` array. Each entry names an Arazzo document and its expectations document, on the same origin and mount as `openApiUrl`:

```json
"journeys": [{ "name": "Store journeys", "arazzoUrl": "/sendproof/journeys/store.arazzo.json", "expectationsUrl": "/sendproof/journeys/store.expect.json" }],
"previewSessions": true
```

An adapter serves files the API's author registers (`.WithJourneys("journeys/store.arazzo.json")` in .NET). A framework adapter can later write Arazzo from route annotations, as it writes OpenAPI today. Each Arazzo `sourceDescriptions` entry must resolve to a document in `documents`; a step whose operation isn't in it, or that targets an AsyncAPI source, is shown as "Not run by Sendproof".

Without `journeys`, Sendproof infers journeys from OpenAPI `links` (a response link from Start cart's 201 to Get cart, carrying `$response.body#/id`). Inferred journeys sit in their own sidebar group, run like any other, and offer **Copy as C#** after a clean Preview, which gives a journey class with its expected writes.

## Defining journeys in code

Journeys are written as C# classes, usually by an AI agent, and reviewed like any other code. At startup the adapter turns every registered journey into the two documents the rest of Sendproof reads: an Arazzo 1.1 workflow and its entry in the expectations document. Both are served from `/sendproof/journeys/` and listed in capabilities, where other Arazzo tools can read them too. Nothing in a definition is a string the compiler can't check, apart from names and literal values.

### The pieces

| Type | What it is |
|---|---|
| `Journey<TInputs>` | One journey. Override `Define` and describe it on the builder |
| `TInputs` | A plain class whose properties are the journey's inputs. Property types, defaults and XML comments become the Arazzo `inputs` schema |
| `StoreOperations` | Generated at build time from the app's endpoints: one typed member per operation (`StoreOperations.Orders.Place`), with the operation's request (path, query, headers and the app's own body type) and its response type |
| `JourneyStep<TRequest, TResponse>` | A step. `Set` binds a request member to a value, `Output` reads a response member, `SucceedsWith` and `ExpectResponse` become `successCriteria` |
| `Ref<T>` | A typed value that exists only at run time: an input or an earlier step's output. A `Ref<Guid>` can only be set where a `Guid` goes |
| `Match` | Values that can't be known in advance: `Match.Any<T>()`, `Match.Pattern(...)`, `Match.Changed(from, to)` |
| `StepWrites` | What a step should write. Each store adds its own entry point as an extension (`Sql<TDbContext>()` in `Sendproof.Journeys.EntityFrameworkCore`, `Mongo()` in `Sendproof.Journeys.MongoDB`), beside `Redis(name)` and `Email()`, so a new store plugs in the same way |
| `ApprovedDifference<T>` | A reviewed record that relaxes one expected value, typed like the field it relaxes |

### A journey

The store example's journeys are in [`examples/StoreApi/Journeys`](../../examples/StoreApi/Journeys); these are them, abridged. They follow the store's real API, so they differ from the mocks in places: an order takes SKUs, not variant IDs; a bank transfer leaves it `Pending` until `PaymentsController.Capture` takes the money; and shipping writes the order, the shipment and an audit row.

```csharp
// Journeys/OrderToShipmentInputs.cs
public sealed class OrderToShipmentInputs
{
    /// <summary>The customer placing the order.</summary>
    public Guid CustomerId { get; set; } = Guid.Parse(DemoData.MiaId);

    /// <summary>The SKU to order. It must be active and in stock.</summary>
    public string Sku { get; set; } = DemoData.JacketSku;

    /// <summary>How many units to order, from 1 to 20.</summary>
    public int Quantity { get; set; } = 1;

    /// <summary>How fast the parcel travels: Standard, Express or Next day.</summary>
    public string ShippingSpeed { get; set; } = "Express";

    /// <summary>The carrier that collects the parcel: Ups, Dhl, FedEx, RoyalMail or CanadaPost.</summary>
    public string Carrier { get; set; } = "Dhl";

    /// <summary>The customer's email, where the order and shipping notices go.</summary>
    public string CustomerEmail { get; set; } = "mia.customer@acme.dev";
}
```

```csharp
// Journeys/OrderToShipmentJourney.cs
using Sendproof.Journeys;

public sealed class OrderToShipmentJourney : Journey<OrderToShipmentInputs>
{
    protected override void Define(JourneyBuilder<OrderToShipmentInputs> journey)
    {
        journey.Name("Order to shipment");
        journey.Group("Checkout and fulfilment");
        journey.RunAs("ada.admin@acme.dev");

        Ref<Guid> customerId = journey.Input(i => i.CustomerId);
        Ref<string> sku = journey.Input(i => i.Sku);
        Ref<int> quantity = journey.Input(i => i.Quantity);

        // 1. Place the order. A bank transfer leaves it Pending until the money arrives.
        var placeOrder = journey.Step("placeOrder", StoreOperations.Orders.Place);
        placeOrder.Set(r => r.Body.CustomerId, customerId);
        placeOrder.Set(r => r.Body.Items[0].Sku, sku);
        placeOrder.Set(r => r.Body.Items[0].Quantity, quantity);
        placeOrder.Set(r => r.Body.ShippingSpeed, journey.Input(i => i.ShippingSpeed));
        placeOrder.Set(r => r.Body.Payment, new BankTransferPayment { BankName = "Bank of Ireland", AccountHolder = "Mia Customer" });
        // … the currency and the delivery address, in OrderRequests.Place
        placeOrder.SucceedsWith(201);
        Ref<Guid> orderId = placeOrder.Output(order => order.Id, "orderId");
        placeOrder.ExpectWrites(writes => PlaceOrderWrites.Describe(writes, customerId, sku, quantity,
            journey.Input(i => i.CustomerEmail), orderId, PaymentMethodKind.BankTransfer));

        // 2. Find its payment.
        var findPayment = journey.Step("findPayment", StoreOperations.Payments.List);
        findPayment.Set(r => r.OrderId, orderId);
        findPayment.SucceedsWith(200);
        Ref<Guid> paymentId = findPayment.Output(page => page.Items[0].Id, "paymentId");
        findPayment.ExpectWrites(writes => writes.Nothing());

        // 3. Capture it: the transfer arrived, so the order is paid.
        var capturePayment = journey.Step("capturePayment", StoreOperations.Payments.Capture);
        capturePayment.Set(r => r.Id, paymentId);
        capturePayment.SucceedsWith(200);
        capturePayment.ExpectResponse(payment => payment.Status, PaymentStatus.Captured);
        capturePayment.ExpectWrites(writes => CapturePaymentWrites.Describe(writes, orderId, paymentId));

        // 4. Ship the parcel, and say what that should write.
        var shipOrder = journey.Step("shipOrder", StoreOperations.Shipments.Create);
        shipOrder.Set(r => r.Body.OrderId, orderId);
        shipOrder.Set(r => r.Body.Carrier, journey.Input(i => i.Carrier));
        shipOrder.SucceedsWith(201);
        shipOrder.ExpectWrites(writes => ShipOrderWrites.Describe(writes, journey, orderId));

        // 5. Read the order back.
        var checkOrder = journey.Step("checkOrder", StoreOperations.Orders.Get);
        checkOrder.Set(r => r.Id, orderId);
        checkOrder.SucceedsWith(200);
        checkOrder.ExpectResponse(order => order.Status, OrderStatus.Shipped);
        checkOrder.ExpectWrites(writes => writes.Nothing());
    }
}
```

`Output` takes the output's name; without one it is the member's JSON name (`id`).

```csharp
// Journeys/ShipOrderWrites.cs
using Sendproof.Journeys;
using Sendproof.Journeys.EntityFrameworkCore;
using Sendproof.Journeys.MongoDB;

public static class ShipOrderWrites
{
    public static void Describe(StepWrites writes, JourneyBuilder<OrderToShipmentInputs> journey, Ref<Guid> orderId)
    {
        SqlWrites<StoreDbContext> sql = writes.Sql<StoreDbContext>();

        sql.Update(db => db.Orders)
            .Where(o => o.Id, orderId)
            .Set(o => o.Status, Match.Changed(OrderStatus.Paid, OrderStatus.Shipped))
            .Set(o => o.UpdatedAt, Match.Any<DateTimeOffset>());

        sql.Insert(db => db.Shipments)
            .Set(s => s.OrderId, orderId)
            .Set(s => s.Carrier, Carrier.Dhl)
            .Set(s => s.Status, ShipmentStatus.LabelCreated)
            .Set(s => s.TrackingNumber, Match.Pattern(@"^JD\d{13}$"))
            .Set(s => s.ShippedAt, Match.Any<DateTimeOffset>());

        sql.Insert(db => db.AuditEvents)
            .Set(a => a.EntityType, "Order")
            .Set(a => a.Action, "Order.Shipped: DHL", StoreApprovedDifferences.CarrierRenamed)
            .Set(a => a.Actor, "ada.admin@acme.dev");

        MongoWrites mongo = writes.Mongo();

        mongo.Insert<OrderEventDocument>()
            .Set(e => e.OrderId, orderId)
            .Set(e => e.Type, "Shipment.Created")
            .Set(e => e.Status, "Shipped");

        mongo.Update<OrderTimelineDocument>()
            .Where(t => t.Id, orderId)
            .Set(t => t.UpdatedAt, Match.Any<DateTime>());

        writes.Email()
            .To(journey.Input(i => i.CustomerEmail))
            .Subject(Match.Pattern("on its way"));
    }
}
```

`OrderEventDocument` and `OrderTimelineDocument` are plain classes with BSON attributes that describe what the store writes, so field names come from their class maps; the collection each lives in is registered with the journeys.

Registering them:

```csharp
// StoreApplication.cs
var sendproof = builder.Services.AddSendproof().WithApiName("Acme Store API");
sendproof.AddEntityFrameworkCore<StoreDbContext>();
sendproof.AddJourneys(typeof(StoreApplication).Assembly, journeys =>
{
    journeys.Name = "Store journeys";
    journeys.FileName = "store";
    journeys.MapCollection<OrderEventDocument>("order_events").MapCollection<OrderTimelineDocument>("order_timelines");
});
```

The generated catalog is named by `[assembly: JourneyOperations("StoreOperations")]` (or the `SendproofOperationsClass` MSBuild property); without either it is named after the assembly, `StoreApiOperations`.

### What the compiler and startup catch

- **Wrong types.** `Set(s => s.OrderId, quantity)` doesn't compile: `OrderId` is a `Guid` and `quantity` a `Ref<int>`. The same holds for literals, matchers and `Match.Changed` on an enum column.
- **Unknown operations, fields and tables.** Operations are members of the generated `StoreOperations`, request and response members are the app's own types, and tables and columns are the `DbContext`'s own sets and properties, so a rename is a compile error or a refactor, never a silent mismatch. Column, collection and field names in the generated documents come from the EF Core model, the MongoDB class maps and the app's JSON naming policy.
- **Order.** An output read from a step that comes later, two steps with one ID, two journeys with one ID, or a `Ref` from another journey stops startup in Development with a list of what's wrong; elsewhere the journey is logged and skipped.
- **Endpoints without names.** The generator names an operation from its `WithName`; an endpoint without one gets warning SPJ001 and its handler's name (or the name its route implies), and its OpenAPI operation has no `operationId` to call until it is named.
- **Stores.** A table the `DbContext` doesn't map, a document class with no registered collection, and a step whose operation no endpoint is named are startup problems too. Field names are the EF Core model's property names, as the Preview changes report them, and table names its table names.

### Stores Preview can't hold

A step can say what it writes to Redis like any other store:

```csharp
// Journeys/PriceCartWrites.cs
public static class PriceCartWrites
{
    public static void Describe(StepWrites writes, Ref<string> quoteId)
    {
        writes.Redis("cache")
            .Command(RedisCommand.Set, RedisKey.Format("quote:{0}", quoteId), expiry: Match.Any<TimeSpan>());
    }
}
```

`RedisKey.Format` writes each ref as `{$expression}` inside the key (`quote:{$steps.priceCart.outputs.quoteId}`), which the runner substitutes. A step's own outputs can be read in its expectations, because writes are compared after the response.

Because Redis can't roll back, a journey with a Redis expectation (or a step whose operation is marked `preview: false`) is **Send only**: the workbench says so before it runs, its Preview run stops at that step with the reason, and its runs in CI go against a throwaway database. Its Redis commands are compared from the traced Send, like SQL writes.

### Approved differences

An approved difference is a plain object, passed to the expectation it relaxes, so its review happens next to it and its `Actual` must have the column's type:

```csharp
// Journeys/StoreApprovedDifferences.cs
public static class StoreApprovedDifferences
{
    public static readonly ApprovedDifference<string> CarrierRenamed = new()
    {
        Id = "AD-0011",
        Actual = "Order.Shipped: Dhl",
        Reason = "The carrier catalog renamed DHL to Dhl (shown as DHL Express) in 2.1, and the audit trail writes the new code. Expectations still say DHL until they're re-recorded.",
        ApprovedBy = "sam.support@acme.dev",
        ApprovedOn = new DateOnly(2026, 11, 12),
        Expires = new DateOnly(2026, 12, 31),
        Link = "https://github.com/acme/store-api/issues/412",
    };
}
```

`ShipOrderWrites` uses it as `.Set(a => a.Action, "Order.Shipped: DHL", StoreApprovedDifferences.CarrierRenamed)`. In the store the shipment's own `Carrier` column holds the enum (`Dhl`), so the renamed code shows in the audit row instead; with another carrier as the input, step 4 fails, because the record covers only `Dhl`. An expired record covers nothing and the run says so. The workbench still never approves: on a finding, **Draft approved difference** gives this object to paste.

### Writing them, and running them

- **AI first.** The MCP server's `list_operations` and `describe_operation` return the generated `StoreOperations` names with their request and response types, so an agent writes a journey that compiles; the build and the startup check tell it what's wrong. The package ships an agent guide for writing journeys.
- **From a Preview.** The workbench's Database tab offers **Copy as C#** on any Preview: the step's actual writes as an `ExpectWrites` block, with values from earlier steps and inputs shown as refs to fill in.
- **As tests.** `Sendproof.Journeys.Testing` runs every journey as a test case in `dotnet test`, in memory through `WebApplicationFactory`, Preview by default:

```csharp
// StoreApi.Tests/JourneyTests.cs
public sealed class JourneyTests : JourneyTestSuite<StoreApplication>, IDisposable
{
    private readonly DirectoryInfo _directory = Directory.CreateTempSubdirectory("store-journeys-");

    // Price with a coupon is Send only, so each journey's host gets a throwaway database.
    protected override bool AllowSend => true;

    protected override void ConfigureWebHost(IWebHostBuilder builder) =>
        builder.UseSetting("DemoDatabasePath", Path.Combine(_directory.FullName, "store.db"));

    public void Dispose()
    {
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        _directory.Delete(recursive: true);
    }
}
```

With no Send-only journeys and a host that holds Preview sessions, the class can be empty: Preview writes nothing. Sending is off unless `AllowSend` says otherwise, so a suite never writes to a developer's database by accident. `StoreApplication` is a class rather than a static class so it can be the entry-point type.

- **In CI and against a deployed API.** `npx sendproof journeys run --all --junit report.xml` runs the same documents against any environment, and agents use the MCP runner; all three read the generated Arazzo.
- **Files still work.** A hand-written or exported Arazzo file can still be registered with `.WithJourneys("journeys/store.arazzo.json")`; other languages' adapters get their own typed builders later, in the same shape.

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

The same runner ships as a CLI and in the MCP server, so QA agents and CI run journeys exactly as people do. The MCP server already exists for the rest of Sendproof (`@sendproof/cli`, [README](../../adapters/node/cli/README.md)): operations, models, lookups, Preview, Send, traces and personas, plus `list_journeys` and `describe_journey`. The run tools below join it with Preview sessions.

```sh
npx sendproof journeys list --api http://127.0.0.1:5189/sendproof
npx sendproof journeys run orderToShipment --mode preview --inputs inputs.json --out run.json --junit report.xml
npx sendproof journeys run orderToShipment --mode send --yes        # send for real; refused outside Development
```

Exit code 0 means passed, 1 failed, 2 couldn't run. Sign-in uses `--persona <email>` (the personas source), `--cookie-jar` or `--header`.

`sendproof mcp --api <url>` is that MCP server, over stdio. The client sends `initialize` with its protocol version, capabilities and `clientInfo`. The server answers with `capabilities: { tools: { listChanged: true } }` and `serverInfo`. The client sends `notifications/initialized`, then calls `tools/list` and `tools/call`. Each tool has an `inputSchema` and an `outputSchema` and returns `structuredContent` with a one-line text summary. A failed step is a normal result; a tool that can't run returns `isError: true`.

| Tool | Does |
| --- | --- |
| `list_operations` | Exists. With typed journeys, each operation also gets its generated code name (`StoreOperations.Orders.Place`) when the adapter publishes them |
| `describe_operation` | Exists. With typed journeys it also gives the C# request and response types |
| `list_journeys` | Exists: journeys with their steps and operations. The last result and any problems the startup check found join with runs and typed journeys |
| `describe_journey` | Exists: steps, bindings, expected writes, approved differences and the inputs' JSON Schema |
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
