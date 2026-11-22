# Sendproof.Cassandra

A write guard for the DataStax C# driver (`CassandraCSharpDriver` 3) in [Sendproof](../../../README.md) Previews.
Cassandra has no rollback, so a Preview runs reads normally and blocks the first write before any byte of it is sent. See
the [.NET data-stores page](../data-stores.md#cassandra) for setup, the `preview: false` mark and what the guard does not
cover.

```csharp
builder.Services.AddSingleton<ISession>(_ => Cluster.Builder().AddContactPoint(host).Build().Connect("shop"));
builder.Services.AddSendproof()
    .AddEntityFrameworkCore<AppDbContext>()
    .AddCassandra(cassandra => cassandra.WithName("tickets"));
```

Register the session (and, if you use it, the `ICluster`) first: `AddCassandra` replaces those registrations with guarded
decorators, and the host refuses to start if either is registered again afterwards.
