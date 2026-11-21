using System.Diagnostics;
using System.Reflection;
using Amazon.DynamoDBv2;
using Amazon.DynamoDBv2.Model;
using Amazon.Runtime;
using Amazon.Runtime.Internal;
using Sendproof.AspNetCore;

namespace Sendproof.DynamoDB;

/// <summary>
/// The DynamoDB write guard: an AWS SDK pipeline handler, added before the marshaller so a refused request is never
/// serialized, signed or sent, and credentials, the <c>Authorization</c> header and signatures never reach the hook.
/// The operation is the request type's name without its <c>Request</c> suffix, such as <c>UpdateItem</c>.
/// </summary>
internal sealed class DynamoGuard(CaptureContext capture, IReadOnlySet<string>? treatAsRead)
{
    /// <summary>Registers the handler with every <see cref="AmazonDynamoDBClient"/> created from now on.</summary>
    internal void Install() => RuntimePipelineCustomizerRegistry.Instance.Register(new Customizer(this));

    private sealed class Customizer(DynamoGuard guard) : IRuntimePipelineCustomizer
    {
        public string UniqueName { get; } = "Sendproof.DynamoDB." + Guid.NewGuid().ToString("N");

        public void Customize(Type serviceClientType, RuntimePipeline pipeline)
        {
            if (typeof(AmazonDynamoDBClient).IsAssignableFrom(serviceClientType))
            {
                pipeline.AddHandlerBefore<Marshaller>(new Handler(guard));
            }
        }
    }

    private sealed class Handler(DynamoGuard guard) : PipelineHandler
    {
        public override void InvokeSync(IExecutionContext executionContext)
        {
            var call = guard.Begin(executionContext.RequestContext.OriginalRequest);
            try
            {
                base.InvokeSync(executionContext);
            }
            catch (Exception error)
            {
                call.Fail(error);
                throw;
            }

            call.Succeed(executionContext.ResponseContext.Response);
        }

        public override async Task<T> InvokeAsync<T>(IExecutionContext executionContext)
        {
            var call = guard.Begin(executionContext.RequestContext.OriginalRequest);
            T response;
            try
            {
                response = await base.InvokeAsync<T>(executionContext).ConfigureAwait(false);
            }
            catch (Exception error)
            {
                call.Fail(error);
                throw;
            }

            call.Succeed(response);
            return response;
        }
    }

    /// <summary>Checks one request before it is sent, and records it as a <c>Db</c> entry when it finishes.</summary>
    private Call Begin(AmazonWebServiceRequest request)
    {
        var operation = OperationOf(request);
        var statements = StatementsOf(request);
        capture.Check("dynamodb", operation, StoreClassifier.ClassifyDynamo(operation, statements, treatAsRead));
        var recorder = capture.Current;
        if (recorder is null)
        {
            return default;
        }

        var statement = statements is { Count: > 0 }
            ? string.Join("; ", statements.Select(item => DataStoreGuard.SanitizePartiql(item ?? "")))
            : null;
        return new Call(recorder, new DbEntry("dynamodb", operation) { Target = TargetOf(request, statements), Statement = statement }, Stopwatch.GetTimestamp());
    }

    private readonly record struct Call(SendproofPreview? Recorder, DbEntry? Entry, long Started)
    {
        internal void Succeed(object? response)
        {
            if (Recorder is null || Entry is null)
            {
                return;
            }

            Recorder.RecordDb(Entry with { RowsAffected = RowsOf(response), ElapsedMs = Stopwatch.GetElapsedTime(Started).TotalMilliseconds });
        }

        internal void Fail(Exception error)
        {
            if (Recorder is null || Entry is null)
            {
                return;
            }

            // A refused write was already logged as a blocked entry by the guard.
            if (error is PreviewWriteBlockedException)
            {
                return;
            }

            var name = error is AmazonServiceException { ErrorCode: { Length: > 0 } code } ? code : error.GetType().Name;
            Recorder.RecordDb(Entry with { Error = name, ElapsedMs = Stopwatch.GetElapsedTime(Started).TotalMilliseconds });
        }
    }

    private static string OperationOf(AmazonWebServiceRequest request)
    {
        var name = request.GetType().Name;
        return name.EndsWith("Request", StringComparison.Ordinal) ? name[..^7] : name;
    }

    /// <summary>The PartiQL text of a PartiQL request: one statement, or one per entry. Other actions have none.</summary>
    private static IReadOnlyList<string?>? StatementsOf(AmazonWebServiceRequest request) => request switch
    {
        ExecuteStatementRequest single => [single.Statement],
        BatchExecuteStatementRequest batch => [.. batch.Statements?.Select(item => item?.Statement) ?? []],
        ExecuteTransactionRequest transaction => [.. transaction.TransactStatements?.Select(item => item?.Statement) ?? []],
        _ => null
    };

    private static readonly Dictionary<Type, PropertyInfo?> TableProperties = [];

    /// <summary>The table a request targets: <c>TableName</c>, the first <c>RequestItems</c> table, or the quoted PartiQL table.</summary>
    private static string? TargetOf(AmazonWebServiceRequest request, IReadOnlyList<string?>? statements)
    {
        PropertyInfo? property;
        lock (TableProperties)
        {
            if (!TableProperties.TryGetValue(request.GetType(), out property))
            {
                TableProperties[request.GetType()] = property = request.GetType().GetProperty("TableName", typeof(string));
            }
        }

        if (property?.GetValue(request) is string table)
        {
            return table;
        }

        switch (request)
        {
            case BatchGetItemRequest get:
                return get.RequestItems?.Keys.FirstOrDefault();
            case BatchWriteItemRequest write:
                return write.RequestItems?.Keys.FirstOrDefault();
        }

        var first = statements?.FirstOrDefault();
        if (first is null)
        {
            return null;
        }

        var start = first.IndexOf('"');
        var end = start < 0 ? -1 : first.IndexOf('"', start + 1);
        return end > start ? first[(start + 1)..end] : null;
    }

    /// <summary>Items matched, returned or written, when the reply says so.</summary>
    private static int? RowsOf(object? response) => response switch
    {
        QueryResponse query => query.Items?.Count ?? query.Count,
        ScanResponse scan => scan.Items?.Count ?? scan.Count,
        ExecuteStatementResponse statement => statement.Items?.Count,
        GetItemResponse get => get.Item is { Count: > 0 } ? 1 : null,
        UpdateItemResponse update => update.Attributes is { Count: > 0 } ? 1 : null,
        PutItemResponse put => put.Attributes is { Count: > 0 } ? 1 : null,
        DeleteItemResponse delete => delete.Attributes is { Count: > 0 } ? 1 : null,
        BatchGetItemResponse batch => batch.Responses?.Values.Sum(items => items.Count),
        _ => null
    };
}
