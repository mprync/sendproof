# Sendproof.OpenSearch

A write guard for `OpenSearch.Client` 2 in [Sendproof](../../../README.md) Previews. OpenSearch has no rollback, so a
Preview runs reads normally and blocks the first write before any byte of it is sent. See the
[.NET data-stores page](../data-stores.md#elasticsearch-and-opensearch) for setup, the `preview: false` mark and what the
guard does not cover.

```csharp
builder.Services.AddSingleton<IOpenSearchClient>(new OpenSearchClient(new ConnectionSettings(new Uri(url))));
builder.Services.AddSendproof()
    .AddEntityFrameworkCore<AppDbContext>()
    .AddOpenSearch(search => search.WithName("articles"));
```

Register the client first: `AddOpenSearch` replaces that registration (`IOpenSearchClient`, `OpenSearchClient` or both) with a
client over a guarded transport, and the host refuses to start if either is registered again afterwards.

For Elasticsearch use [Sendproof.Elasticsearch](../Sendproof.Elasticsearch/README.md).
