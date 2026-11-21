# Sendproof.DynamoDB

A write guard for the AWS SDK for .NET DynamoDB client in [Sendproof](../../../README.md) Previews. DynamoDB has no
rollback, so a Preview runs reads normally and blocks the first write before it is signed or sent. See the
[.NET data-stores page](../data-stores.md) for setup, the `preview: false` mark and what the guard does not cover.

```csharp
builder.Services.AddSendproof()
    .AddEntityFrameworkCore<AppDbContext>()
    .AddDynamoDB(dynamo => dynamo.WithName("orders"));

// Registered after AddDynamoDB, so the client is created with the guard in its pipeline.
builder.Services.AddSingleton<IAmazonDynamoDB>(new AmazonDynamoDBClient());
```

The guard is a pipeline handler added to every `AmazonDynamoDBClient` created after `AddDynamoDB` runs, which also covers
`DynamoDBContext`. A client created earlier is not covered.
