using Microsoft.Extensions.DependencyInjection;
using Sendproof.AspNetCore;

namespace Sendproof.DynamoDB;

/// <summary>Configures the DynamoDB write guard.</summary>
public sealed class DynamoStoreBuilder
{
    private readonly List<string> _reads = [];

    /// <summary>Gets the optional display label shown in discovery.</summary>
    internal string? Name { get; private set; }

    internal IReadOnlyList<string> Reads => _reads;

    /// <summary>
    /// Labels the store in discovery, such as <c>orders</c>. Never an endpoint, ARN or credential: it is shown to
    /// anyone who can open the workbench.
    /// </summary>
    public DynamoStoreBuilder WithName(string name)
    {
        Name = DataStoreGuard.Label(name);
        return this;
    }

    /// <summary>Declares API actions that never write, matched exactly (<c>"DescribeStream"</c>).</summary>
    /// <remarks>
    /// This is your statement that the action never writes. An action you list wrongly is not blocked, and a Preview of
    /// it may leave a write behind.
    /// </remarks>
    public DynamoStoreBuilder TreatAsRead(params string[] actions)
    {
        _reads.AddRange(DataStoreGuard.ReadSet(actions, name => name));
        return this;
    }
}

/// <summary>Registers the DynamoDB write guard for the AWS SDK for .NET.</summary>
public static class SendproofDynamoDbExtensions
{
    /// <summary>
    /// Guards DynamoDB in Previews. DynamoDB has no rollback, so reads run and the first write blocks the Preview before
    /// it is sent. This adds a pipeline handler to every <c>AmazonDynamoDBClient</c> created after it runs, including
    /// the one under <c>DynamoDBContext</c>. A client created earlier, or by code that never saw this registration, is
    /// not covered.
    /// </summary>
    public static SendproofBuilder AddDynamoDB(this SendproofBuilder builder, Action<DynamoStoreBuilder>? configure = null)
    {
        ArgumentNullException.ThrowIfNull(builder);
        var options = new DynamoStoreBuilder();
        configure?.Invoke(options);
        var reads = options.Reads.Count == 0 ? null : new HashSet<string>(options.Reads, StringComparer.Ordinal);
        var guard = new DynamoGuard(builder.Capture, reads);
        guard.Install();
        builder.Services.AddSingleton<IPreviewDataStore>(new DynamoStore(options.Name));
        return builder;
    }
}

/// <summary>The DynamoDB data store: its discovery entry. The guard itself lives in the SDK pipeline.</summary>
internal sealed class DynamoStore(string? name) : IPreviewDataStore
{
    public string System => "dynamodb";

    public ValueTask<DataStoreDescription> DescribeAsync(CancellationToken cancellationToken) =>
        ValueTask.FromResult(new DataStoreDescription("dynamodb", name, "guard"));
}
