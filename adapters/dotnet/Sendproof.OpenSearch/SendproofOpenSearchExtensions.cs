using Microsoft.Extensions.DependencyInjection;
using OpenSearch.Client;
using OpenSearch.Net;
using Sendproof.AspNetCore;

namespace Sendproof.OpenSearch;

/// <summary>Configures the OpenSearch write guard.</summary>
public sealed class OpenSearchStoreBuilder
{
    private readonly List<string> _reads = [];

    /// <summary>Gets the optional display label shown in discovery.</summary>
    internal string? Name { get; private set; }

    internal IReadOnlyList<string> Reads => _reads;

    /// <summary>
    /// Labels the store in discovery, such as <c>articles</c>. Never a URL, host name or password: it is shown to anyone who
    /// can open the workbench.
    /// </summary>
    public OpenSearchStoreBuilder WithName(string name)
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
    public OpenSearchStoreBuilder TreatAsRead(params string[] endpoints)
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

/// <summary>Registers the OpenSearch write guard for <c>OpenSearch.Client</c>.</summary>
public static class SendproofOpenSearchExtensions
{
    /// <summary>
    /// Guards OpenSearch in Previews. OpenSearch has no rollback, so reads run and the first write blocks the Preview before
    /// it is sent. Register the <see cref="IOpenSearchClient"/> (or <see cref="OpenSearchClient"/>) first: this replaces that
    /// registration with a client over a guarded transport, so everything resolved from the container is covered, and the host
    /// refuses to start when the client is registered again afterwards. A client the application creates some other way is
    /// not covered; pass it through <see cref="OpenSearchStore.Guard(IOpenSearchClient)"/>.
    /// </summary>
    public static SendproofBuilder AddOpenSearch(this SendproofBuilder builder, Action<OpenSearchStoreBuilder>? configure = null)
    {
        ArgumentNullException.ThrowIfNull(builder);
        var options = new OpenSearchStoreBuilder();
        configure?.Invoke(options);
        var services = builder.Services;
        var store = new OpenSearchStore(builder.Capture, options.Name, new HashSet<string>(options.Reads, StringComparer.Ordinal));

        if (!services.Any(descriptor => descriptor.ServiceType == typeof(IOpenSearchClient) || descriptor.ServiceType == typeof(OpenSearchClient)))
        {
            throw new InvalidOperationException(
                "Register an IOpenSearchClient (or an OpenSearchClient) before AddOpenSearch, or guard a client you create yourself with OpenSearchStore.Guard.");
        }

        // Every IOpenSearchClient and OpenSearchClient registration, keyed or not, is decorated. A derived client, a low-level
        // client or a bare transport can't be rebuilt over a guarded transport as its own type, so it stops the host instead.
        GuardRegistration.DecorateAll(services, [typeof(IOpenSearchClient), typeof(OpenSearchClient)],
            [typeof(IOpenSearchClient), typeof(IOpenSearchLowLevelClient), typeof(ITransport<IConnectionSettingsValues>)],
            (type, client) => type == typeof(OpenSearchClient) ? store.Guard((OpenSearchClient)client) : store.Guard((IOpenSearchClient)client),
            store.IsGuarded, nameof(AddOpenSearch),
            "Register the client as IOpenSearchClient or OpenSearchClient before AddOpenSearch, and use the guarded client's LowLevel for low-level calls.");
        services.AddSingleton(store);
        services.AddSingleton<IPreviewDataStore>(store);
        return builder;
    }

    /// <summary>
    /// Wraps a client in the Preview write guard, for one created outside the container. Call <see cref="AddOpenSearch"/> first.
    /// </summary>
    public static IOpenSearchClient WithSendproofGuard(this IOpenSearchClient client, IServiceProvider services)
    {
        ArgumentNullException.ThrowIfNull(client);
        ArgumentNullException.ThrowIfNull(services);
        return services.GetRequiredService<OpenSearchStore>().Guard(client);
    }
}

/// <summary>The OpenSearch data store: its discovery entry and its guard.</summary>
public sealed class OpenSearchStore : IPreviewDataStore
{
    private readonly string? _name;
    private readonly OpenSearchGuard _guard;

    internal OpenSearchStore(CaptureContext capture, string? name, IReadOnlySet<string> reads)
    {
        _name = name;
        _guard = new OpenSearchGuard(capture, reads.Count == 0 ? null : reads);
    }

    /// <inheritdoc />
    public string System => OpenSearchGuard.Store;

    /// <inheritdoc />
    public ValueTask<DataStoreDescription> DescribeAsync(CancellationToken cancellationToken) =>
        ValueTask.FromResult(new DataStoreDescription(OpenSearchGuard.Store, _name, "guard"));

    /// <summary>
    /// Returns a client that shares the given client's settings but sends every request through the write guard. A client
    /// that is already guarded by this store is returned as it is.
    /// </summary>
    public IOpenSearchClient Guard(IOpenSearchClient client) =>
        OpenSearchGuard.IsGuarded(client, _guard) ? client : new OpenSearchClient(_guard.Guard(OpenSearchGuard.TransportOf(client)));

    /// <inheritdoc cref="Guard(IOpenSearchClient)" />
    public OpenSearchClient Guard(OpenSearchClient client) =>
        OpenSearchGuard.IsGuarded(client, _guard) ? client : new OpenSearchClient(_guard.Guard(OpenSearchGuard.TransportOf(client)));

    /// <summary>
    /// Whether a registered instance is a client or transport this store guards. A low-level client registered on its own is
    /// never accepted: its transport can't be read.
    /// </summary>
    internal bool IsGuarded(object registered) => registered switch
    {
        IOpenSearchClient client => OpenSearchGuard.IsGuarded(client, _guard),
        ITransport<IConnectionSettingsValues> transport => OpenSearchGuard.IsGuardedTransport(transport, _guard),
        _ => false
    };
}
