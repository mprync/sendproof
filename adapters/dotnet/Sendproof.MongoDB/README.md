# Sendproof.MongoDB

Previews for the MongoDB .NET driver in [Sendproof](../../../README.md). On a replica set or sharded cluster a Preview
runs in a transaction (snapshot read concern, majority write concern) that is aborted after the handler, and its document
changes are captured. On a standalone server MongoDB can't run transactions, so the Preview runs in guard mode: reads run
and the first write blocks it. See the [.NET data-stores page](../data-stores.md) for setup, the `preview: false` mark and
what the hook does not cover. An observed Send (`Prefer: trace`) commits its writes and traces the same document changes,
`before` and `after`, on a replica set or a standalone server alike.

```csharp
builder.Services.AddSingleton<IMongoClient>(new MongoClient(mongoUrl));
builder.Services.AddSendproof()
    .AddEntityFrameworkCore<AppDbContext>()
    .AddMongoDB(mongo => mongo.WithName("catalog"));
```

Register the client first: `AddMongoDB` replaces that registration with a decorator whose databases and collections add the
Preview's session to every call.
