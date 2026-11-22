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
