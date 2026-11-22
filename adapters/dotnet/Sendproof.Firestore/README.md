# Sendproof.Firestore

A write guard for `Google.Cloud.Firestore` in [Sendproof](../../../README.md) Previews. A Firestore transaction can't
hold an arbitrary handler's writes, so a Preview runs reads normally and blocks the first write before any byte of it is
sent. See the [.NET data-stores page](../data-stores.md#google-cloud-firestore) for setup, the `preview: false` mark and
what the guard does not cover.

```csharp
builder.Services.AddSingleton(FirestoreDb.Create(projectId));
builder.Services.AddSendproof()
    .AddEntityFrameworkCore<AppDbContext>()
    .AddFirestore(firestore => firestore.WithName("orders"));
```

Register the `FirestoreDb` first: `AddFirestore` replaces that registration with a database over a client whose gRPC
channel carries the guard (unary, server-streaming, client-streaming and duplex calls alike), and the host refuses to
start if `FirestoreDb` is registered again afterwards.
