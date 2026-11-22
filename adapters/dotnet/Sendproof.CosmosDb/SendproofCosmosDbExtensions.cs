using Microsoft.Azure.Cosmos;
using Microsoft.Azure.Cosmos.Fluent;
using Microsoft.Extensions.DependencyInjection;
using Sendproof.AspNetCore;

namespace Sendproof.CosmosDb;

/// <summary>Configures the Cosmos DB write guard.</summary>
public sealed class CosmosDbStoreBuilder
{
    private readonly List<string> _reads = [];

    /// <summary>Gets the optional display label shown in discovery.</summary>
    internal string? Name { get; private set; }

    internal IReadOnlyList<string> Reads => _reads;

    /// <summary>
    /// Labels the store in discovery, such as <c>orders</c>. Never an account endpoint, key or connection string: it is shown
    /// to anyone who can open the workbench.
    /// </summary>
    public CosmosDbStoreBuilder WithName(string name)
    {
        Name = DataStoreGuard.Label(name);
        return this;
    }

    /// <summary>
    /// Declares operation types that never write, such as one a newer service adds (<c>"FutureRead"</c>). Exact names only,
    /// no wildcards.
    /// </summary>
    /// <remarks>
    /// This is your statement that the operation never writes. An operation you list wrongly is not blocked, and a Preview of
    /// it may leave a write behind.
    /// </remarks>
    public CosmosDbStoreBuilder TreatAsRead(params string[] operations)
    {
        _reads.AddRange(DataStoreGuard.ReadSet(operations, name => name));
        return this;
    }
}

/// <summary>Registers the Cosmos DB write guard for the Azure Cosmos DB .NET SDK.</summary>
public static class SendproofCosmosDbExtensions
{
    /// <summary>
    /// Registers the Cosmos DB write guard. Cosmos DB can only roll back inside one logical partition, so reads run and the
    /// first write blocks the Preview before it is sent. The guard is a request handler on the client's own pipeline, so the
    /// client has to be built with it: add <see cref="WithSendproofGuard(CosmosClientOptions, IServiceProvider)"/> to its
    /// options. A <see cref="CosmosClient"/> registered in the container without it stops the host from starting, because
    /// Preview would let its writes through.
    /// </summary>
    public static SendproofBuilder AddCosmosDb(this SendproofBuilder builder, Action<CosmosDbStoreBuilder>? configure = null)
    {
        ArgumentNullException.ThrowIfNull(builder);
        var options = new CosmosDbStoreBuilder();
        configure?.Invoke(options);
        var services = builder.Services;
        var store = new CosmosDbStore(builder.Capture, options.Name, new HashSet<string>(options.Reads, StringComparer.Ordinal));
        services.AddSingleton(store);
        services.AddSingleton<IPreviewDataStore>(store);
        GuardRegistration.Require(services, provider => store.Problem(services, provider));
        return builder;
    }

    /// <summary>
    /// Adds the Preview write guard to the options of a <see cref="CosmosClient"/>. Call <see cref="AddCosmosDb"/> first.
    /// Adding it twice has no effect.
    /// </summary>
    public static CosmosClientOptions WithSendproofGuard(this CosmosClientOptions options, IServiceProvider services)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(services);
        services.GetRequiredService<CosmosDbStore>().Guard(options);
        return options;
    }

    /// <summary>
    /// Adds the Preview write guard to a <see cref="CosmosClientBuilder"/>. Call <see cref="AddCosmosDb"/> first.
    /// </summary>
    public static CosmosClientBuilder WithSendproofGuard(this CosmosClientBuilder builder, IServiceProvider services)
    {
        ArgumentNullException.ThrowIfNull(builder);
        ArgumentNullException.ThrowIfNull(services);
        return builder.AddCustomHandlers(services.GetRequiredService<CosmosDbStore>().CreateHandler());
    }
}

/// <summary>The Cosmos DB data store: its discovery entry and its guard.</summary>
public sealed class CosmosDbStore : IPreviewDataStore
{
    private readonly string? _name;
    private readonly CosmosGuard _guard;

    internal CosmosDbStore(CaptureContext capture, string? name, IReadOnlySet<string> reads)
    {
        _name = name;
        _guard = new CosmosGuard(capture, reads.Count == 0 ? null : reads);
    }

    /// <inheritdoc />
    public string System => CosmosGuard.Store;

    /// <inheritdoc />
    public ValueTask<DataStoreDescription> DescribeAsync(CancellationToken cancellationToken) =>
        ValueTask.FromResult(new DataStoreDescription(CosmosGuard.Store, _name, "guard"));

    /// <summary>Creates the request handler that checks each request, for <see cref="CosmosClientBuilder.AddCustomHandlers"/>.</summary>
    public RequestHandler CreateHandler() => _guard.CreateHandler();

    /// <summary>Adds the write guard to the options of a client, once.</summary>
    public void Guard(CosmosClientOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        if (!_guard.HasHandler(options))
        {
            options.CustomHandlers.Add(_guard.CreateHandler());
        }
    }

    /// <summary>
    /// The sentence the startup check refuses with, or <see langword="null"/>: every <see cref="CosmosClient"/> registered
    /// in the container must carry this store's handler.
    /// </summary>
    internal string? Problem(IServiceCollection services, IServiceProvider provider)
    {
        // Every registration counts, keyed or not and by any class deriving from CosmosClient, and so does every earlier
        // registration of a service, which IEnumerable<T> still resolves.
        var groups = services.Where(descriptor => typeof(CosmosClient).IsAssignableFrom(descriptor.ServiceType))
            .Select(descriptor => (descriptor.ServiceType, descriptor.IsKeyedService, Key: descriptor.ServiceKey)).Distinct().ToArray();
        if (groups.Length == 0)
        {
            return null;
        }

        using var scope = provider.CreateScope();
        foreach (var (type, keyed, key) in groups)
        {
            var name = keyed ? $"{type.Name} (keyed \"{key}\")" : type.Name;
            if (keyed && ReferenceEquals(key, KeyedService.AnyKey))
            {
                return $"The {type.Name} registered for any key can't be checked, so Sendproof can't confirm it is guarded. Register each key's client.";
            }

            var clients = keyed ? scope.ServiceProvider.GetKeyedServices(type, key) : scope.ServiceProvider.GetServices(type);
            foreach (var client in clients.OfType<CosmosClient>())
            {
                if (!CosmosGuard.CanInspect(client))
                {
                    return $"Sendproof can't inspect this version of the Cosmos DB SDK's client options, so it can't confirm the registered {name} is guarded. Update Sendproof.CosmosDb.";
                }

                if (!_guard.IsGuarded(client))
                {
                    return $"The {name} registered in the container was built without the Sendproof guard, so Preview would let its writes through. " +
                           "Build it with new CosmosClientOptions().WithSendproofGuard(provider).";
                }
            }
        }

        return null;
    }
}
