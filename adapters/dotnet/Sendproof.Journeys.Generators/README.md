# Sendproof.Journeys.Generators

The Roslyn incremental source generator behind typed journeys. It ships inside the
[Sendproof.Journeys](../Sendproof.Journeys/README.md) package as an analyzer, so a package reference is enough; a project
reference names it as one:

```xml
<ProjectReference Include="../Sendproof.Journeys.Generators/Sendproof.Journeys.Generators.csproj"
                  OutputItemType="Analyzer" ReferenceOutputAssembly="false" />
```

## What it generates

From every minimal-API `MapGet`, `MapPost`, `MapPut`, `MapPatch` and `MapDelete` call, one typed operation:

```csharp
internal static partial class StoreOperations
{
    internal static class Orders
    {
        internal static readonly JourneyOperation<PlaceRequest, global::StoreApi.Order> Place = new("OrdersController.Place", "POST");

        internal sealed class PlaceRequest
        {
            [FromHeader(Name = "Idempotency-Key")] public string? IdempotencyKey { get; set; }
            [FromBody] public global::StoreApi.PlaceOrderRequest Body { get; set; } = default!;
        }
    }
}
```

- **Name and group.** The endpoint's `WithName`: `OrdersController.Place` becomes `Orders.Place`.
- **Request.** Route parameters (including those of `MapGroup` prefixes held in locals), query parameters, `[FromHeader]`
  headers, and the body: the `[FromBody]` parameter, or else the first parameter of a complex type that isn't a known
  context or service type (`DbContext`, `ClaimsPrincipal`, `HttpContext`, interfaces, `[FromServices]`). Mark the body
  `[FromBody]` when a service class comes before it.
- **Response.** The type of the first `Produces<T>` with a 2xx status; `object` when there is none.
- **Journey files.** A `[assembly: JourneySource(typeof(…), "Journeys/….cs")]` per journey class, so the expectations
  document can say where each journey is defined.

The class is named by `[assembly: JourneyOperations("StoreOperations")]`, else the `SendproofOperationsClass` MSBuild
property, else the assembly name plus `Operations`; it goes in the root namespace.

## Diagnostics

| ID | Severity | Meaning |
| --- | --- | --- |
| SPJ001 | Warning | An endpoint has no `WithName`, so its OpenAPI operation has no operationId. It is in the catalog under its handler's name, but a step can't call it until it is named |
| SPJ002 | Warning | Two operations map to one catalog name; the second is left out |
