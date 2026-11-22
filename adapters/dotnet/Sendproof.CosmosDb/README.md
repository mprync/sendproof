# Sendproof.CosmosDb

A write guard for the Azure Cosmos DB .NET SDK (`Microsoft.Azure.Cosmos` 3) in [Sendproof](../../../README.md) Previews.
Cosmos DB can only roll back inside one logical partition, so a Preview runs reads normally and blocks the first write
before any byte of it is sent. See the [.NET data-stores page](../data-stores.md#azure-cosmos-db) for setup, the
`preview: false` mark and what the guard does not cover.

```csharp
builder.Services.AddSendproof()
    .AddEntityFrameworkCore<AppDbContext>()
    .AddCosmosDb(cosmos => cosmos.WithName("orders"));

// The guard is a request handler on the client's pipeline, so the client is built with it.
builder.Services.AddSingleton(provider => new CosmosClient(connectionString,
    new CosmosClientOptions().WithSendproofGuard(provider)));
```

`AddCosmosDb` registers the guard. A `CosmosClient` that is registered in the container but built without it stops the
host from starting.
