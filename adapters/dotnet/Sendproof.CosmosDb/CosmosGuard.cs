using System.Reflection;
using System.Text;
using System.Text.Json;
using Microsoft.Azure.Cosmos;
using Sendproof.AspNetCore;

namespace Sendproof.CosmosDb;

/// <summary>
/// The Cosmos DB write guard: a <see cref="RequestHandler"/> in <see cref="CosmosClientOptions.CustomHandlers"/>. Every
/// operation of every container, database and bulk or batch executor of the client goes through the SDK's request pipeline
/// before it is sent over the gateway or direct connection, so a refused write is never sent. The operation is derived from
/// the HTTP method, the resource path and the request headers, as <c>fromRequest</c> in spec/data-stores/cosmosdb.json lists,
/// because <c>RequestMessage.OperationType</c> is internal. When the SDK's own operation type can be read it is checked too, and
/// a write by either rule is a write.
/// </summary>
internal sealed class CosmosGuard(CaptureContext capture, IReadOnlySet<string>? treatAsRead)
{
    /// <summary>The store id in <c>Db</c> entries and the 409 body.</summary>
    internal const string Store = "cosmosdb";

    private string? _bulkClient;

    /// <summary>
    /// Why every Preview is unavailable: a client in bulk mode sends through this guard. Bulk mode has no hook where an operation
    /// is queued, so an operation a Preview handler queues without awaiting it could be sent after the Preview ended, when no
    /// Preview is open to refuse its batch.
    /// </summary>
    internal string? BlockedReason => Volatile.Read(ref _bulkClient) is { } client
        ? $"Preview unavailable: this application has a Cosmos DB client in bulk mode (AllowBulkExecution: {client}), whose queued writes Sendproof can't refuse"
        : null;

    /// <summary>
    /// Makes every Preview unavailable because of a bulk-mode client. <paramref name="replace"/> lets the startup check put the
    /// registration's name in place of a less precise one.
    /// </summary>
    internal void BlockBulk(string client, bool replace = false)
    {
        if (replace)
        {
            Volatile.Write(ref _bulkClient, client);
        }
        else
        {
            Interlocked.CompareExchange(ref _bulkClient, client, null);
        }
    }

    /// <summary>Whether a client runs in bulk mode, by its options; a client whose options can't be read is not.</summary>
    internal static bool InBulkMode(CosmosClient client) => OptionsOf(client)?.AllowBulkExecution == true;

    /// <summary>Creates the request handler that checks each request. Add it to <see cref="CosmosClientOptions.CustomHandlers"/>.</summary>
    internal RequestHandler CreateHandler() => new GuardHandler(this);

    /// <summary>Whether client options already carry this guard's handler.</summary>
    internal bool HasHandler(CosmosClientOptions options) =>
        options.CustomHandlers.OfType<GuardHandler>().Any(handler => ReferenceEquals(handler.Guard, this));

    /// <summary>Whether a client was built with this guard's handler.</summary>
    internal bool IsGuarded(CosmosClient client) => OptionsOf(client) is { } options && HasHandler(options);

    /// <summary>
    /// Whether the client's options can be inspected at all. They sit in an internal property of <see cref="CosmosClient"/>; a
    /// future SDK that moves it makes the startup check refuse rather than assume the client is guarded.
    /// </summary>
    internal static bool CanInspect(CosmosClient client) => OptionsOf(client) is not null;

    private static readonly PropertyInfo? ClientOptionsProperty = typeof(CosmosClient).GetProperty(
        "ClientOptions", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);

    private static CosmosClientOptions? OptionsOf(CosmosClient client) => ClientOptionsProperty?.GetValue(client) as CosmosClientOptions;

    private static readonly PropertyInfo? OperationTypeProperty = typeof(RequestMessage).GetProperty(
        "OperationType", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);

    /// <summary>The SDK's own operation type name for a request, when it can be read.</summary>
    private static string? SdkOperation(RequestMessage request) => OperationTypeProperty?.GetValue(request)?.ToString();

    private sealed class GuardHandler(CosmosGuard guard) : RequestHandler
    {
        internal CosmosGuard Guard => guard;

        public override async Task<ResponseMessage> SendAsync(RequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri?.OriginalString ?? "";
            var call = guard.Begin(request, path);
            ResponseMessage response;
            try
            {
                response = await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception error)
            {
                call.Fail(error);
                throw;
            }

            if (response.IsSuccessStatusCode)
            {
                call.Succeed();
            }
            else
            {
                call.Fail(new HttpRequestException(((int)response.StatusCode).ToString()), ((int)response.StatusCode).ToString());
            }

            return response;
        }
    }

    private DbCall Begin(RequestMessage request, string path)
    {
        string? Header(string name) => request.Headers.TryGetValue(name, out var value) ? value : null;
        if (IsBulkBatch(Header))
        {
            // Bulk mode (AllowBulkExecution) queues item operations without passing them through the request handlers and sends
            // them later as one non-atomic batch, from the SDK's dispatcher, whose context is that of whichever request created
            // it. So the batch's context can't say whose operations it carries: it is refused whenever a Preview is open, and is
            // not logged, because any request's trace could be the wrong one. A client the startup check didn't see in bulk mode
            // (one the application keeps itself) shows itself here, and from now on no Preview runs.
            BlockBulk("a client built outside the container");
            capture.RefuseUnattributableWrite(Store, "Batch");
            return default;
        }

        var classification = CosmosClassifier.Classify(request.Method.Method, path, Header);
        if (SdkOperation(request) is { } sdk && classification.Kind == CommandKind.Read &&
            CosmosClassifier.Classify(sdk, triggered: false) is { Kind: CommandKind.Write } sdkClassification &&
            StoreTables.Cosmos.Canonical.ContainsKey(sdk.ToLowerInvariant()))
        {
            classification = sdkClassification;
        }

        if (classification.Kind == CommandKind.Write && treatAsRead?.Contains(classification.Operation) == true)
        {
            classification = classification with { Kind = CommandKind.Read };
        }

        return DbCall.Begin(capture, Store, classification, () => new DbEntry(Store, classification.Operation)
        {
            Target = CosmosClassifier.Container(path),
            Namespace = CosmosClassifier.Database(path),
            Statement = classification.Operation is "Query" ? QueryText(request) : null
        });
    }

    /// <summary>
    /// Whether a request is a bulk-mode batch: a batch request that is not atomic. A transactional batch (atomic) is sent from
    /// the caller's own context and is classified like any other request.
    /// </summary>
    private static bool IsBulkBatch(Func<string, string?> header) =>
        string.Equals(header("x-ms-cosmos-is-batch-request"), "true", StringComparison.OrdinalIgnoreCase) &&
        !string.Equals(header("x-ms-cosmos-batch-atomic"), "true", StringComparison.OrdinalIgnoreCase);

    /// <summary>The SQL text of a query request with every literal replaced by <c>?</c>. Parameter values are never read.</summary>
    private static string? QueryText(RequestMessage request)
    {
        var body = request.Content;
        if (body is null || !body.CanSeek || !body.CanRead)
        {
            return null;
        }

        var position = body.Position;
        try
        {
            using var reader = new StreamReader(body, Encoding.UTF8, false, 1024, leaveOpen: true);
            using var document = JsonDocument.Parse(reader.ReadToEnd());
            return document.RootElement.ValueKind == JsonValueKind.Object && document.RootElement.TryGetProperty("query", out var query) && query.GetString() is { } text
                ? StatementShape.Redact(text)
                : null;
        }
        catch (Exception error) when (error is JsonException or IOException or InvalidOperationException)
        {
            return null;
        }
        finally
        {
            body.Position = position;
        }
    }
}
