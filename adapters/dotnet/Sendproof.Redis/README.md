# Sendproof.Redis

A write guard for StackExchange.Redis in [Sendproof](../../../README.md) Previews. Redis has no rollback, so a Preview
runs reads normally and blocks the first write before any byte of it is sent. See the
[.NET data-stores page](../data-stores.md) for setup, the `preview: false` mark and what the guard does not cover.

```csharp
builder.Services.AddSingleton<IConnectionMultiplexer>(ConnectionMultiplexer.Connect(redisUrl));
builder.Services.AddSendproof()
    .AddEntityFrameworkCore<AppDbContext>()
    .AddRedis(redis => redis.WithName("cache"));
```

Register the multiplexer first: `AddRedis` replaces that registration with a guarded decorator.
