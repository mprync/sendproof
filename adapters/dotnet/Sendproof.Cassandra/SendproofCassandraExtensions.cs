using Cassandra;
using Microsoft.Extensions.DependencyInjection;
using Sendproof.AspNetCore;

namespace Sendproof.Cassandra;

/// <summary>Configures the Cassandra write guard.</summary>
public sealed class CassandraStoreBuilder
{
    private readonly List<string> _reads = [];

    /// <summary>Gets the optional display label shown in discovery.</summary>
    internal string? Name { get; private set; }

    internal IReadOnlyList<string> Reads => _reads;

    /// <summary>
    /// Labels the store in discovery, such as <c>tickets</c>. Never a contact point, keyspace credentials or connection
    /// string: it is shown to anyone who can open the workbench.
    /// </summary>
    public CassandraStoreBuilder WithName(string name)
    {
        Name = DataStoreGuard.Label(name);
        return this;
    }

    /// <summary>
    /// Declares statement keywords that never write, such as a keyword a newer Cassandra adds (<c>"FUTUREREAD"</c>).
    /// Exact keywords only, no wildcards.
    /// </summary>
    /// <remarks>
    /// This is your statement that the keyword never writes. A keyword you list wrongly is not blocked, and a Preview of it
    /// may leave a write behind.
    /// </remarks>
    public CassandraStoreBuilder TreatAsRead(params string[] keywords)
    {
        _reads.AddRange(DataStoreGuard.ReadSet(keywords, keyword => keyword.ToUpperInvariant()));
        return this;
    }
}

/// <summary>Registers the Cassandra write guard for the DataStax C# driver.</summary>
public static class SendproofCassandraExtensions
{
    /// <summary>
    /// Guards Cassandra in Previews. Cassandra has no rollback, so reads run and the first write blocks the Preview before it
    /// is sent. Register the <see cref="ISession"/> (and the <see cref="ICluster"/>, if the application resolves it) first:
    /// this replaces those registrations with guarded decorators, so everything resolved from the container is covered, and
    /// the host refuses to start when either is registered again afterwards. A session or cluster the application created
    /// some other way is not covered; pass it through <see cref="CassandraStore.Guard(ISession)"/>.
    /// </summary>
    public static SendproofBuilder AddCassandra(this SendproofBuilder builder, Action<CassandraStoreBuilder>? configure = null)
    {
        ArgumentNullException.ThrowIfNull(builder);
        var options = new CassandraStoreBuilder();
        configure?.Invoke(options);
        var services = builder.Services;
        var store = new CassandraStore(builder.Capture, options.Name, new HashSet<string>(options.Reads, StringComparer.Ordinal));

        bool Registered(Type type) => services.Any(descriptor => descriptor.ServiceType == type && !descriptor.IsKeyedService);
        var hasCluster = Registered(typeof(ICluster));
        var hasSession = Registered(typeof(ISession));
        if (!hasCluster && !hasSession)
        {
            throw new InvalidOperationException(
                "Register an ISession (or an ICluster) before AddCassandra, or guard a session you create yourself with CassandraStore.Guard.");
        }

        services.AddSingleton(store);
        services.AddSingleton<IPreviewDataStore>(store);
        if (hasCluster)
        {
            GuardRegistration.Decorate(services, typeof(ICluster), cluster => store.Guard((ICluster)cluster), nameof(AddCassandra));
        }

        if (hasSession)
        {
            GuardRegistration.Decorate(services, typeof(ISession), session => store.Guard((ISession)session), nameof(AddCassandra));
        }

        return builder;
    }

    /// <summary>
    /// Wraps a session in the Preview write guard, for one created outside the container. Call <see cref="AddCassandra"/> first.
    /// </summary>
    public static ISession WithSendproofGuard(this ISession session, IServiceProvider services)
    {
        ArgumentNullException.ThrowIfNull(session);
        ArgumentNullException.ThrowIfNull(services);
        return services.GetRequiredService<CassandraStore>().Guard(session);
    }
}

/// <summary>The Cassandra data store: its discovery entry and its guard.</summary>
public sealed class CassandraStore : IPreviewDataStore
{
    private readonly string? _name;
    private readonly CassandraGuard _guard;

    internal CassandraStore(CaptureContext capture, string? name, IReadOnlySet<string> reads)
    {
        _name = name;
        _guard = new CassandraGuard(capture, reads.Count == 0 ? null : reads);
    }

    /// <inheritdoc />
    public string System => "cassandra";

    /// <inheritdoc />
    public ValueTask<DataStoreDescription> DescribeAsync(CancellationToken cancellationToken) =>
        ValueTask.FromResult(new DataStoreDescription("cassandra", _name, "guard"));

    /// <summary>Wraps a session in the write guard. Its <c>Cluster</c> is guarded too.</summary>
    public ISession Guard(ISession session) => _guard.Guard(session);

    /// <summary>Wraps a cluster in the write guard: every session it connects is guarded.</summary>
    public ICluster Guard(ICluster cluster) => _guard.Guard(cluster);
}
