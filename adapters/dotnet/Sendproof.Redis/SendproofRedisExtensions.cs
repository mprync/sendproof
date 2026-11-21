using Microsoft.Extensions.DependencyInjection;
using Sendproof.AspNetCore;
using StackExchange.Redis;

namespace Sendproof.Redis;

/// <summary>Configures the Redis write guard.</summary>
public sealed class RedisStoreBuilder
{
    private readonly List<string> _reads = [];

    /// <summary>Gets the optional display label shown in discovery.</summary>
    internal string? Name { get; private set; }

    internal IReadOnlyList<string> Reads => _reads;

    internal bool DecorateRegisteredMultiplexer { get; private set; } = true;

    /// <summary>
    /// Labels the store in discovery, such as <c>cache</c>. Never a connection string, URL, host or password: it is
    /// shown to anyone who can open the workbench.
    /// </summary>
    public RedisStoreBuilder WithName(string name)
    {
        Name = DataStoreGuard.Label(name);
        return this;
    }

    /// <summary>
    /// Declares commands that never write, such as a custom module command (<c>"MYMODULE.GET"</c>). Exact names
    /// only, no wildcards.
    /// </summary>
    /// <remarks>
    /// This is your statement that the command never writes. A command you list wrongly is not blocked, and a
    /// Preview of it may leave a write behind.
    /// </remarks>
    public RedisStoreBuilder TreatAsRead(params string[] commands)
    {
        _reads.AddRange(DataStoreGuard.ReadSet(commands, name => name.ToUpperInvariant()));
        return this;
    }

    /// <summary>
    /// Leaves the registered <see cref="IConnectionMultiplexer"/> alone. Use this when the multiplexer is created
    /// elsewhere, such as <c>RedisCacheOptions.ConnectionMultiplexerFactory</c>, and guard it yourself with
    /// <see cref="SendproofRedisExtensions.WithSendproofGuard"/>.
    /// </summary>
    public RedisStoreBuilder WithoutDecoratingTheRegisteredMultiplexer()
    {
        DecorateRegisteredMultiplexer = false;
        return this;
    }
}

/// <summary>Registers the Redis write guard for StackExchange.Redis.</summary>
public static class SendproofRedisExtensions
{
    /// <summary>
    /// Guards Redis in Previews. Redis has no rollback, so reads run and the first write blocks the Preview before it is
    /// sent. Register the <see cref="IConnectionMultiplexer"/> first: this replaces that registration with a guarded
    /// decorator, so everything resolved from the container is covered. A client created some other way is not.
    /// </summary>
    public static SendproofBuilder AddRedis(this SendproofBuilder builder, Action<RedisStoreBuilder>? configure = null)
    {
        ArgumentNullException.ThrowIfNull(builder);
        var options = new RedisStoreBuilder();
        configure?.Invoke(options);
        var services = builder.Services;
        var store = new RedisStore(builder.Capture, options.Name, new HashSet<string>(options.Reads, StringComparer.Ordinal));
        services.AddSingleton(store);
        services.AddSingleton<IPreviewDataStore>(store);

        if (options.DecorateRegisteredMultiplexer)
        {
            var original = services.LastOrDefault(descriptor => descriptor.ServiceType == typeof(IConnectionMultiplexer) && !descriptor.IsKeyedService) ??
                throw new InvalidOperationException(
                    "Register an IConnectionMultiplexer before AddRedis, or call WithoutDecoratingTheRegisteredMultiplexer() and guard it with WithSendproofGuard.");
            services.Remove(original);
            services.Add(ServiceDescriptor.Describe(typeof(IConnectionMultiplexer),
                provider => store.Guard((IConnectionMultiplexer)Resolve(provider, original)),
                original.Lifetime == ServiceLifetime.Transient ? ServiceLifetime.Transient : ServiceLifetime.Singleton));
        }

        return builder;
    }

    /// <summary>
    /// Wraps a multiplexer in the Preview write guard, for one created outside the container, such as the one
    /// <c>RedisCacheOptions.ConnectionMultiplexerFactory</c> returns. Call <see cref="AddRedis"/> first.
    /// </summary>
    public static IConnectionMultiplexer WithSendproofGuard(this IConnectionMultiplexer multiplexer, IServiceProvider services)
    {
        ArgumentNullException.ThrowIfNull(multiplexer);
        ArgumentNullException.ThrowIfNull(services);
        return services.GetRequiredService<RedisStore>().Guard(multiplexer);
    }

    private static object Resolve(IServiceProvider provider, ServiceDescriptor descriptor) =>
        descriptor.ImplementationInstance ??
        (descriptor.ImplementationFactory is { } factory
            ? factory(provider)
            : ActivatorUtilities.CreateInstance(provider, descriptor.ImplementationType!));
}

/// <summary>The Redis data store: its discovery entry and its guard.</summary>
public sealed class RedisStore : IPreviewDataStore
{
    private readonly string? _name;
    private readonly RedisGuard _guard;

    internal RedisStore(CaptureContext capture, string? name, IReadOnlySet<string> reads)
    {
        _name = name;
        _guard = new RedisGuard(capture, reads.Count == 0 ? null : reads);
    }

    /// <inheritdoc />
    public string System => "redis";

    /// <inheritdoc />
    public ValueTask<DataStoreDescription> DescribeAsync(CancellationToken cancellationToken) =>
        ValueTask.FromResult(new DataStoreDescription("redis", _name, "guard"));

    /// <summary>Wraps a multiplexer in the write guard.</summary>
    public IConnectionMultiplexer Guard(IConnectionMultiplexer multiplexer) => _guard.Guard(multiplexer);
}
