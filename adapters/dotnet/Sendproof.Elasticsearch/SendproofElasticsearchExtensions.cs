using Elastic.Clients.Elasticsearch;
using Microsoft.Extensions.DependencyInjection;
using Sendproof.AspNetCore;

namespace Sendproof.Elasticsearch;

/// <summary>Configures the Elasticsearch write guard.</summary>
public sealed class ElasticsearchStoreBuilder
{
    private readonly List<string> _reads = [];

    /// <summary>Gets the optional display label shown in discovery.</summary>
    internal string? Name { get; private set; }

    internal IReadOnlyList<string> Reads => _reads;

    /// <summary>
    /// Labels the store in discovery, such as <c>articles</c>. Never a URL, host name, API key or password: it is shown to
    /// anyone who can open the workbench.
    /// </summary>
    public ElasticsearchStoreBuilder WithName(string name)
    {
        Name = DataStoreGuard.Label(name);
        return this;
    }

    /// <summary>
    /// Declares endpoints that never write, by the endpoint id the table names (<c>"search"</c>) or, for an endpoint the
    /// table doesn't list, the operation name the guard reports (<c>"POST /{}/_future_read"</c>). Exact names only.
    /// </summary>
    /// <remarks>
    /// This is your statement that the endpoint never writes. An endpoint you list wrongly is not blocked, and a Preview of
    /// it may leave a write behind.
    /// </remarks>
    public ElasticsearchStoreBuilder TreatAsRead(params string[] endpoints)
    {
        foreach (var name in endpoints)
        {
            // Operation names such as "POST /{}/_future_read" hold spaces, so this is not DataStoreGuard.ReadSet.
            if (string.IsNullOrWhiteSpace(name) || name.Contains('*') || name.Contains('?'))
            {
                throw new ArgumentException("TreatAsRead takes exact endpoint names, without wildcards.", nameof(endpoints));
            }

            _reads.Add(name.Trim());
        }

        return this;
    }
}

/// <summary>Registers the Elasticsearch write guard for <c>Elastic.Clients.Elasticsearch</c>.</summary>
public static class SendproofElasticsearchExtensions
{
    /// <summary>
    /// Guards Elasticsearch in Previews. Elasticsearch has no rollback, so reads run and the first write blocks the Preview
    /// before it is sent. Register the <see cref="ElasticsearchClient"/> first: this replaces that registration with a client
    /// over a guarded transport, so everything resolved from the container is covered, and the host refuses to start when the
    /// client is registered again afterwards. A client the application creates some other way is not covered; pass it
    /// through <see cref="ElasticsearchStore.Guard"/>.
    /// </summary>
    public static SendproofBuilder AddElasticsearch(this SendproofBuilder builder, Action<ElasticsearchStoreBuilder>? configure = null)
    {
        ArgumentNullException.ThrowIfNull(builder);
        var options = new ElasticsearchStoreBuilder();
        configure?.Invoke(options);
        var services = builder.Services;
        var store = new ElasticsearchStore(builder.Capture, options.Name, new HashSet<string>(options.Reads, StringComparer.Ordinal));
        // Every ElasticsearchClient registration, keyed or not, is decorated. A derived client or a bare transport can't be
        // rebuilt over a guarded transport as its own type, so it stops the host instead.
        GuardRegistration.DecorateAll(services, [typeof(ElasticsearchClient)], [typeof(ElasticsearchClient), typeof(Elastic.Transport.ITransport)],
            (_, client) => store.Guard((ElasticsearchClient)client), store.IsGuarded, nameof(AddElasticsearch),
            "Register it as ElasticsearchClient before AddElasticsearch, or resolve the guarded ElasticsearchClient and use its Transport.");
        services.AddSingleton(store);
        services.AddSingleton<IPreviewDataStore>(store);
        return builder;
    }

    /// <summary>
    /// Wraps a client in the Preview write guard, for one created outside the container. Call <see cref="AddElasticsearch"/> first.
    /// </summary>
    public static ElasticsearchClient WithSendproofGuard(this ElasticsearchClient client, IServiceProvider services)
    {
        ArgumentNullException.ThrowIfNull(client);
        ArgumentNullException.ThrowIfNull(services);
        return services.GetRequiredService<ElasticsearchStore>().Guard(client);
    }
}

/// <summary>The Elasticsearch data store: its discovery entry and its guard.</summary>
public sealed class ElasticsearchStore : IPreviewDataStore
{
    private readonly string? _name;
    private readonly ElasticsearchGuard _guard;

    internal ElasticsearchStore(CaptureContext capture, string? name, IReadOnlySet<string> reads)
    {
        _name = name;
        _guard = new ElasticsearchGuard(capture, reads.Count == 0 ? null : reads);
    }

    /// <inheritdoc />
    public string System => ElasticsearchGuard.Store;

    /// <inheritdoc />
    public ValueTask<DataStoreDescription> DescribeAsync(CancellationToken cancellationToken) =>
        ValueTask.FromResult(new DataStoreDescription(ElasticsearchGuard.Store, _name, "guard"));

    /// <summary>
    /// Returns a client that shares the given client's settings but sends every request through the write guard. A client
    /// that is already guarded by this store is returned as it is.
    /// </summary>
    public ElasticsearchClient Guard(ElasticsearchClient client) =>
        ElasticsearchGuard.IsGuarded(client, _guard) ? client : new ElasticsearchClient(_guard.Guard(client.Transport));

    /// <summary>Whether a registered instance is a client or transport this store guards.</summary>
    internal bool IsGuarded(object registered) => registered switch
    {
        ElasticsearchClient client => ElasticsearchGuard.IsGuarded(client, _guard),
        _ => ElasticsearchGuard.IsGuardedTransport(registered, _guard)
    };
}
