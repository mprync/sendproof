using Google.Cloud.Firestore;
using Google.Cloud.Firestore.V1;
using Grpc.Core;
using Microsoft.Extensions.DependencyInjection;
using Sendproof.AspNetCore;

namespace Sendproof.Firestore;

/// <summary>Configures the Firestore write guard.</summary>
public sealed class FirestoreStoreBuilder
{
    private readonly List<string> _reads = [];

    /// <summary>Gets the optional display label shown in discovery.</summary>
    internal string? Name { get; private set; }

    internal IReadOnlyList<string> Reads => _reads;

    /// <summary>
    /// Labels the store in discovery, such as <c>orders</c>. Never a project id, credentials path or key: it is shown to anyone
    /// who can open the workbench.
    /// </summary>
    public FirestoreStoreBuilder WithName(string name)
    {
        Name = DataStoreGuard.Label(name);
        return this;
    }

    /// <summary>
    /// Declares gRPC methods of the Firestore v1 service that never write, such as one a newer API adds
    /// (<c>"FutureRead"</c>). Exact method names only, no wildcards.
    /// </summary>
    /// <remarks>
    /// This is your statement that the method never writes. A method you list wrongly is not blocked, and a Preview of it may
    /// leave a write behind.
    /// </remarks>
    public FirestoreStoreBuilder TreatAsRead(params string[] methods)
    {
        _reads.AddRange(DataStoreGuard.ReadSet(methods, name => name));
        return this;
    }
}

/// <summary>Registers the Firestore write guard for <c>Google.Cloud.Firestore</c>.</summary>
public static class SendproofFirestoreExtensions
{
    /// <summary>
    /// Guards Firestore in Previews. A Firestore transaction can't hold an arbitrary handler's writes, so reads run and the
    /// first write blocks the Preview before it is sent. Register the <see cref="FirestoreDb"/> first: this replaces that
    /// registration with a database over a client whose gRPC channel carries the guard, so everything resolved from the
    /// container is covered, and the host refuses to start when <see cref="FirestoreDb"/> is registered again afterwards. A
    /// database the application creates some other way is not covered; pass it through <see cref="FirestoreStore.Guard(FirestoreDb)"/>.
    /// </summary>
    public static SendproofBuilder AddFirestore(this SendproofBuilder builder, Action<FirestoreStoreBuilder>? configure = null)
    {
        ArgumentNullException.ThrowIfNull(builder);
        var options = new FirestoreStoreBuilder();
        configure?.Invoke(options);
        var services = builder.Services;
        var store = new FirestoreStore(builder.Capture, options.Name, new HashSet<string>(options.Reads, StringComparer.Ordinal));
        // Every FirestoreDb and FirestoreClient registration, keyed or not, is decorated. The generated gRPC client can't be
        // rebuilt over a guarded call invoker as its own type, so it stops the host instead.
        GuardRegistration.DecorateAll(services, [typeof(FirestoreDb), typeof(FirestoreClient)],
            [typeof(FirestoreDb), typeof(FirestoreClient), typeof(Google.Cloud.Firestore.V1.Firestore.FirestoreClient)],
            (type, client) => type == typeof(FirestoreDb) ? store.Guard((FirestoreDb)client) : store.Guard((FirestoreClient)client),
            store.IsGuarded, nameof(AddFirestore),
            "Register FirestoreDb or FirestoreClient before AddFirestore, and use them instead of the generated gRPC client.");
        services.AddSingleton(store);
        services.AddSingleton<IPreviewDataStore>(store);
        return builder;
    }

    /// <summary>
    /// Wraps a database in the Preview write guard, for one created outside the container. Call <see cref="AddFirestore"/> first.
    /// </summary>
    public static FirestoreDb WithSendproofGuard(this FirestoreDb db, IServiceProvider services)
    {
        ArgumentNullException.ThrowIfNull(db);
        ArgumentNullException.ThrowIfNull(services);
        return services.GetRequiredService<FirestoreStore>().Guard(db);
    }
}

/// <summary>The Firestore data store: its discovery entry and its guard.</summary>
public sealed class FirestoreStore : IPreviewDataStore
{
    private readonly string? _name;
    private readonly FirestoreGuard _guard;

    internal FirestoreStore(CaptureContext capture, string? name, IReadOnlySet<string> reads)
    {
        _name = name;
        _guard = new FirestoreGuard(capture, reads.Count == 0 ? null : reads);
    }

    /// <inheritdoc />
    public string System => FirestoreGuard.Store;

    /// <inheritdoc />
    public ValueTask<DataStoreDescription> DescribeAsync(CancellationToken cancellationToken) =>
        ValueTask.FromResult(new DataStoreDescription(FirestoreGuard.Store, _name, "guard"));

    /// <summary>
    /// Returns a database over a client whose gRPC calls pass through the write guard, for the same project and database as
    /// <paramref name="db"/>. A database that is already guarded by this store is returned as it is. The new client uses the
    /// default call settings, so a custom retry policy on the original client does not carry over.
    /// </summary>
    public FirestoreDb Guard(FirestoreDb db)
    {
        ArgumentNullException.ThrowIfNull(db);
        if (_guard.IsGuarded(db))
        {
            return db;
        }

        // A database over a client this store already guards sends through the guard once, not twice.
        if (_guard.IsGuarded(db.Client))
        {
            return _guard.Mark(db);
        }

        return _guard.Mark(FirestoreGuard.WithClient(db, Guard(db.Client)));
    }

    /// <summary>
    /// Returns a client whose gRPC calls pass through the write guard, over the same call invoker as <paramref name="client"/>.
    /// A client that is already guarded by this store is returned as it is. The new client uses the default call settings.
    /// </summary>
    public FirestoreClient Guard(FirestoreClient client)
    {
        ArgumentNullException.ThrowIfNull(client);
        return _guard.IsGuarded(client)
            ? client
            : _guard.Mark(new FirestoreClientBuilder { CallInvoker = _guard.Guard(FirestoreGuard.InvokerOf(client)) }.Build());
    }

    /// <summary>Whether a registered instance is a database or client this store guards.</summary>
    internal bool IsGuarded(object registered) => registered switch
    {
        FirestoreDb db => _guard.IsGuarded(db),
        FirestoreClient client => _guard.IsGuarded(client),
        _ => false
    };

    /// <summary>
    /// Puts the write guard in front of a call invoker, for a <see cref="FirestoreClientBuilder"/> you configure yourself:
    /// <c>new FirestoreClientBuilder { CallInvoker = store.Guard(invoker) }</c>.
    /// </summary>
    public CallInvoker Guard(CallInvoker invoker)
    {
        ArgumentNullException.ThrowIfNull(invoker);
        return _guard.Guard(invoker);
    }
}
