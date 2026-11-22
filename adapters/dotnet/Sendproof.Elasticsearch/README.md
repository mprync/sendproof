# Sendproof.Elasticsearch

A write guard for `Elastic.Clients.Elasticsearch` 8 in [Sendproof](../../../README.md) Previews. Elasticsearch has no
rollback, so a Preview runs reads normally and blocks the first write before any byte of it is sent. See the
[.NET data-stores page](../data-stores.md#elasticsearch-and-opensearch) for setup, the `preview: false` mark and what the
guard does not cover.

```csharp
builder.Services.AddSingleton(new ElasticsearchClient(new ElasticsearchClientSettings(new Uri(url))));
builder.Services.AddSendproof()
    .AddEntityFrameworkCore<AppDbContext>()
    .AddElasticsearch(search => search.WithName("articles"));
```

Register the client first: `AddElasticsearch` replaces that registration with a client over a guarded transport, and the
host refuses to start if `ElasticsearchClient` is registered again afterwards.

For OpenSearch use [Sendproof.OpenSearch](../Sendproof.OpenSearch/README.md).
