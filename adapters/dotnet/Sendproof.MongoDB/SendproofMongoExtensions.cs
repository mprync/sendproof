using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using MongoDB.Driver;
using Sendproof.AspNetCore;

namespace Sendproof.MongoDB;

/// <summary>Configures the MongoDB hook.</summary>
public sealed class MongoStoreBuilder
{
    private readonly List<string> _reads = [];

    /// <summary>Gets the optional display label shown in discovery.</summary>
    internal string? Name { get; private set; }

    internal IReadOnlyList<string> Reads => _reads;

    internal bool Monitoring { get; private set; } = true;

    /// <summary>A test seam: builds the client without command monitoring, as one created some other way would be.</summary>
    internal MongoStoreBuilder WithoutMonitoringForTests()
    {
        Monitoring = false;
        return this;
    }

    internal TimeSpan PreviewTimeout { get; private set; } = MongoEngine.DefaultPreviewTimeout;

    /// <summary>
    /// Labels the store in discovery, such as <c>catalog</c>. Never a connection string, URL, host or password: it is shown
    /// to anyone who can open the workbench.
    /// </summary>
    public MongoStoreBuilder WithName(string name)
    {
        Name = DataStoreGuard.Label(name);
        return this;
    }

    /// <summary>Declares commands that never write, matched exactly and case-insensitively (<c>"someReadCommand"</c>).</summary>
    /// <remarks>
    /// This is your statement that the command never writes. A command you list wrongly is not blocked, and a Preview of it
    /// may leave a write behind.
    /// </remarks>
    public MongoStoreBuilder TreatAsRead(params string[] commands)
    {
        _reads.AddRange(DataStoreGuard.ReadSet(commands, name => name.ToLowerInvariant()));
        return this;
    }

    /// <summary>
    /// Sets how long a Preview's transaction may run before it is aborted and the Preview answers 500. The default is
    /// 50 seconds, below the server's 60-second <c>transactionLifetimeLimitSeconds</c>, so the binding, not the server,
    /// ends a Preview whose handler runs too long.
    /// </summary>
    public MongoStoreBuilder WithPreviewTimeout(TimeSpan timeout)
    {
        if (timeout <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(timeout), "The Preview time limit must be positive.");
        }

        PreviewTimeout = timeout;
        return this;
    }
}

/// <summary>Registers the MongoDB hook for the MongoDB .NET driver.</summary>
public static class SendproofMongoExtensions
{
    /// <summary>
    /// Hooks MongoDB into Previews. On a replica set or sharded cluster a Preview runs in a transaction that is aborted
    /// afterwards, with document changes captured; on a standalone server the first write blocks the Preview. Register the
    /// <see cref="IMongoClient"/> first: this replaces that registration with a decorator whose databases and collections add
    /// the Preview's session to every call, and which reports command events for the tripwire. It creates its own client
    /// from the registered client's settings. A client or collection the application created some other way is not covered.
    /// </summary>
    public static SendproofBuilder AddMongoDB(this SendproofBuilder builder, Action<MongoStoreBuilder>? configure = null)
    {
        ArgumentNullException.ThrowIfNull(builder);
        var options = new MongoStoreBuilder();
        configure?.Invoke(options);
        var services = builder.Services;
        var original = services.LastOrDefault(descriptor => descriptor.ServiceType == typeof(IMongoClient) && !descriptor.IsKeyedService) ??
            throw new InvalidOperationException("Register an IMongoClient before AddMongoDB: it replaces that registration with a guarded decorator.");
        var reads = options.Reads.Count == 0 ? null : new HashSet<string>(options.Reads, StringComparer.Ordinal);
        var engine = new MongoEngine(builder.Capture, reads, options.PreviewTimeout) { MonitoringEnabled = options.Monitoring };
        var store = new MongoStore(engine, options.Name);

        services.Remove(original);
        services.AddSingleton(provider =>
        {
            var registered = (IMongoClient)(original.ImplementationInstance ??
                (original.ImplementationFactory is { } factory ? factory(provider) : ActivatorUtilities.CreateInstance(provider, original.ImplementationType!)));
            engine.Logger = provider.GetService<Microsoft.Extensions.Logging.ILogger<MongoStore>>();
            return store.Decorate(registered);
        });
        // The store is only usable once the decorated client exists, so resolving the store resolves the client first.
        services.AddSingleton<IPreviewDataStore>(provider =>
        {
            _ = provider.GetRequiredService<IMongoClient>();
            return store;
        });
        return builder;
    }
}

/// <summary>The MongoDB data store: its discovery entry and the Preview transaction.</summary>
internal sealed class MongoStore(MongoEngine engine, string? name) : IPreviewDataStore, IPreviewSessionSource
{
    public string System => "mongodb";

    internal MongoEngine Engine => engine;

    /// <summary>Builds the instrumented client from the registered one's settings, and returns its guarded decorator.</summary>
    internal IMongoClient Decorate(IMongoClient registered)
    {
        // The driver reports command events only to subscribers configured before the client connects, so the decorator
        // makes its own client from the registered one's settings, keeping any configurator the host already set.
        var settings = registered.Settings.Clone();
        var previous = settings.ClusterConfigurator;
        settings.ClusterConfigurator = builder =>
        {
            previous?.Invoke(builder);
            engine.Subscribe(builder);
        };
        engine.Original = registered;
        engine.Client = new MongoClient(settings);
        return engine.GuardedClient = GuardedMongo.Wrap<IMongoClient>(engine, engine.Client, GuardedMongo.Kind.Client);
    }

    public async ValueTask<DataStoreDescription> DescribeAsync(CancellationToken cancellationToken)
    {
        var (mode, reason) = await engine.DetectAsync();
        return new DataStoreDescription("mongodb", name, mode, reason);
    }

    public async ValueTask BeginPreviewAsync(SendproofPreview preview, CancellationToken cancellationToken) =>
        await engine.BeginAsync(preview, cancellationToken);

    public async ValueTask FinishPreviewAsync(SendproofPreview preview, CancellationToken cancellationToken) =>
        await engine.FinishAsync(preview, cancellationToken);

    /// <summary>
    /// An observed Send's writes commit, so its changes are read around each write: the documents before it, and again after the
    /// handler. Needs no transaction, so it works on a standalone server as well.
    /// </summary>
    public IPreviewObservation? BeginObservation(HttpContext context) =>
        engine.MonitoringEnabled ? engine.Observe(context.RequestServices.GetRequiredService<SendproofPreview>()) : null;

    public async ValueTask<IHeldPreview?> HoldAsync(HttpContext context, CancellationToken cancellationToken) =>
        await engine.HoldAsync(cancellationToken);
}

/// <summary>
/// A preview session's MongoDB transaction. Each step joins it through the guarded client; undoing a step or rewinding
/// writes back the before images the steps' change capture kept, inside the same transaction.
/// </summary>
internal sealed class MongoHeldPreview(MongoEngine engine, MongoEngine.PreviewState state) : IHeldPreview
{
    /// <summary>The session's client session and step images.</summary>
    internal MongoEngine.PreviewState State => state;

    public string? EndedReason => state.Held!.EndedReason;

    public ValueTask BeginStepAsync(HttpContext context, SendproofPreview preview, int step, CancellationToken cancellationToken)
    {
        engine.JoinStep(state, preview, step);
        return ValueTask.CompletedTask;
    }

    public ValueTask KeepStepAsync(CancellationToken cancellationToken) =>
        EndedReason is { } ended ? throw new PreviewSessionFailedException(ended) : ValueTask.CompletedTask;

    public async ValueTask UndoStepAsync(CancellationToken cancellationToken) =>
        await engine.RewindAsync(state, state.Held!.Step, cancellationToken);

    public async ValueTask RewindAsync(int step, CancellationToken cancellationToken) =>
        await engine.RewindAsync(state, step, cancellationToken);

    public async ValueTask EndAsync() => await engine.EndSessionAsync(state);
}
