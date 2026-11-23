# Sendproof.Journeys

Typed journeys for [Sendproof](../../../README.md). A journey is an ordered set of API calls a person makes to finish a
task, such as taking an order through to shipment, with what each call should write. You write journeys as C# classes;
at startup this package turns them into an [Arazzo 1.1](https://spec.openapis.org/arazzo/v1.1.html) document and a
Sendproof expectations document, serves both under `/sendproof/journeys/`, and lists them in capabilities. The
workbench, `sendproof journeys run` and `Sendproof.Journeys.Testing` all run journeys from those documents. The design
is [docs/plans/journeys.md](../../../docs/plans/journeys.md).

## Register journeys

```csharp
var sendproof = builder.Services.AddSendproof().WithApiName("Acme Store API");
sendproof.AddEntityFrameworkCore<StoreDbContext>();
sendproof.AddJourneys(typeof(StoreApplication).Assembly, journeys =>
{
    journeys.Name = "Store journeys";      // the name the workbench shows
    journeys.FileName = "store";           // /sendproof/journeys/store.arazzo.json and store.expect.json
    journeys.MapCollection<OrderEventDocument>("order_events");
});
```

- `AddJourneys(assembly)` registers every journey class in an assembly; `AddJourney<TJourney>()` registers one.
- `WithJourneys("journeys/store.arazzo.json")` serves a hand-written or exported Arazzo file (JSON or YAML), with
  `store.expect.json` beside it as its expectations when there is one. Capabilities list it with `"source": "file"`.
- Journeys are published only where Sendproof is enabled (Development by default), behind the same authorization policy.

## Write a journey

```csharp
public sealed class OrderToShipmentJourney : Journey<OrderToShipmentInputs>
{
    protected override void Define(JourneyBuilder<OrderToShipmentInputs> journey)
    {
        journey.Name("Order to shipment");
        journey.Group("Checkout and fulfilment");
        journey.RunAs("ada.admin@acme.dev");

        var placeOrder = journey.Step("placeOrder", StoreOperations.Orders.Place);
        placeOrder.Set(r => r.Body.CustomerId, journey.Input(i => i.CustomerId));
        placeOrder.SucceedsWith(201);
        Ref<Guid> orderId = placeOrder.Output(order => order.Id, "orderId");

        var checkOrder = journey.Step("checkOrder", StoreOperations.Orders.Get);
        checkOrder.Set(r => r.Id, orderId);
        checkOrder.ExpectResponse(order => order.Status, OrderStatus.Paid);
        checkOrder.ExpectWrites(writes => writes.Nothing());
    }
}
```

| Type | What it is |
| --- | --- |
| `Journey<TInputs>` | One journey. Its workflowId is the class name without `Journey`, camel-cased, unless `journey.Id(...)` sets it |
| `TInputs` | A plain class of inputs. Property types, defaults and XML comments become the Arazzo `inputs` schema |
| `JourneyStep<TRequest, TResponse>` | `Set` binds a request member, `Output` reads a response member, `SucceedsWith` and `ExpectResponse` become `successCriteria`, `ExpectWrites` says what the step writes, `RunAs` changes its persona |
| `Ref<T>` | An input or an earlier output. A `Ref<Guid>` only goes where a `Guid` goes |
| `Match` | `Match.Any<T>()`, `Match.Pattern(regex)`, `Match.Changed(from, to)` for values not known in advance |
| `ApprovedDifference<T>` | A reviewed record that allows one known difference, typed like the field it relaxes |

## Say what a step writes

```csharp
using Sendproof.Journeys.EntityFrameworkCore;
using Sendproof.Journeys.MongoDB;

shipOrder.ExpectWrites(writes =>
{
    writes.Sql<StoreDbContext>().Update(db => db.Orders)
        .Where(o => o.Id, orderId)
        .Set(o => o.Status, Match.Changed(OrderStatus.Paid, OrderStatus.Shipped));
    writes.Mongo().Insert<OrderEventDocument>().Set(e => e.Type, "Shipment.Created");
    writes.Redis("cache").Command(RedisCommand.Set, RedisKey.Format("quote:{0}", quoteId), expiry: Match.Any<TimeSpan>());
    writes.Email().To(journey.Input(i => i.CustomerEmail)).Subject(Match.Pattern("on its way"));
});
```

- **SQL.** Tables are the `DbContext`'s sets and columns its entities' properties. The expectations name them as the
  EF Core model and the Preview change capture do: the model's table name, and each property's name.
- **MongoDB.** A document class (with BSON attributes, or a class map) names the fields; register its collection with
  `journeys.MapCollection<TDocument>("…")`.
- **Redis.** Redis can't roll back, so a journey that expects a Redis command is **Send only**. So is a journey with a
  step whose operation is marked `preview: false`.
- **Nothing.** `writes.Nothing()` means the step must write nothing, such as a read or an expected refusal.
- A change to a table or collection nobody listed fails the step. `journeys.Ignore("sqlite", "__EFMigrationsHistory")`
  leaves out a table that changes on every request.

## The operations catalog

The `Sendproof.Journeys.Generators` source generator (in this package) writes a typed catalog from the app's
minimal-API `Map*` calls: `StoreOperations.Orders.Place` is the endpoint named `OrdersController.Place`, with its route,
query and header parameters and its handler's body type as the request, and its first successful `Produces<T>` as the
response. Name the class with `[assembly: JourneyOperations("StoreOperations")]` or the `SendproofOperationsClass`
MSBuild property; the default is the assembly name plus `Operations`. See its [README](../Sendproof.Journeys.Generators/README.md).

## What startup checks

In Development a problem stops startup with every problem listed (`JourneyValidationException`); elsewhere each is
logged and the journey or file is skipped:

- an output read before its step answers, two steps or two journeys with one ID, a `Ref` from another journey;
- a step whose operation no mapped endpoint is named;
- an entity the `DbContext` doesn't map, a document class without a collection, a field the model doesn't have;
- an approved difference used by two expectations, or without an ID, a reason or an approver;
- anything Bielu.Arazzo's validator finds in the generated workflow.

## Libraries

Bielu.Arazzo.NET (MIT) builds, writes and validates the Arazzo document and reads registered files. Table and field
names come from Microsoft.EntityFrameworkCore.Relational and MongoDB.Bson, the inputs schema from System.Text.Json's
`JsonSchemaExporter`, and its descriptions through Namotion.Reflection (MIT).
