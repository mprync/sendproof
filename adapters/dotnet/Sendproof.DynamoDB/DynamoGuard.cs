using System.Diagnostics;
using System.Reflection;
using Amazon;
using Amazon.DynamoDBv2;
using Amazon.DynamoDBv2.Model;
using Amazon.Runtime;
using Amazon.Runtime.Internal;
using Amazon.Runtime.Telemetry;
using Amazon.Runtime.Telemetry.Tracing;
using Sendproof.AspNetCore;

namespace Sendproof.DynamoDB;

/// <summary>
/// The DynamoDB write guard: an AWS SDK pipeline handler, added before the marshaller so a refused request is never
/// serialized, signed or sent, and credentials, the <c>Authorization</c> header and signatures never reach the hook.
/// The operation is the request type's name without its <c>Request</c> suffix, such as <c>UpdateItem</c>.
/// </summary>
/// <remarks>
/// The pipeline handler only reaches clients created after <see cref="Install"/>. A client created earlier still asks the
/// SDK's global tracer provider for a span on every request, before it is sent, so the guard also wraps that provider:
/// a write by name through any DynamoDB client is blocked there, and a PartiQL request the handler never saw (its
/// statements can't be read from the span) fails the Preview with 500 when it ends.
/// </remarks>
internal sealed class DynamoGuard(CaptureContext capture, IReadOnlySet<string>? treatAsRead)
{
    /// <summary>The tracer scope the AWS SDK uses for DynamoDB requests.</summary>
    private const string TracerScope = "AWSSDK.DynamoDB";

    /// <summary>The PartiQL request a span opened in this async flow, until the pipeline handler marks it seen.</summary>
    private readonly AsyncLocal<Unseen?> _unseen = new();

    /// <summary>Registers the handler with every <see cref="AmazonDynamoDBClient"/> created from now on, and the tracer for older ones.</summary>
    internal void Install()
    {
        RuntimePipelineCustomizerRegistry.Instance.Register(new Customizer(this));
        EnsureTracer();
    }

    /// <summary>
    /// Puts the guard's tracer provider in front of the SDK's global one, delegating to it. Runs again before each Preview,
    /// so a provider the host registered later (OpenTelemetry's, say) is wrapped instead of silently replacing the guard.
    /// </summary>
    internal void EnsureTracer()
    {
        var telemetry = AWSConfigs.TelemetryProvider;
        lock (telemetry)
        {
            for (var current = telemetry.TracerProvider; current is GuardTracerProvider guarded; current = guarded.Inner)
            {
                if (ReferenceEquals(guarded.Guard, this))
                {
                    return;
                }
            }

            telemetry.RegisterTracerProvider(new GuardTracerProvider(this, telemetry.TracerProvider));
        }
    }

    /// <summary>A PartiQL request seen only by the tracer so far, and the Preview it ran in.</summary>
    internal sealed class Unseen(string operation)
    {
        internal string Operation { get; } = operation;

        internal volatile bool Seen;
    }

    /// <summary>The PartiQL requests of one Preview that the pipeline handler never saw.</summary>
    internal sealed class UnseenRequests
    {
        internal System.Collections.Concurrent.ConcurrentQueue<Unseen> Requests { get; } = new();
    }

    /// <summary>
    /// Checks a request from the tracer, before it is sent. Runs for every DynamoDB client, hooked or not: an action that is
    /// a write by name is refused here; a PartiQL action is left to the pipeline handler, which reads its statements.
    /// </summary>
    private void BeforeSend(string spanName)
    {
        // A request's span is "DynamoDB.{Action}"; the SDK's inner spans (credentials, signing) are not requests.
        if (!spanName.StartsWith("DynamoDB.", StringComparison.Ordinal))
        {
            return;
        }

        var operation = spanName["DynamoDB.".Length..];
        // Every request starts unmarked: a marker left by an earlier synchronous call must never be taken as this
        // request's, or a later hooked call would mark an unchecked PartiQL request seen.
        _unseen.Value = null;
        if (!StoreTables.Dynamo.PartiQl.Contains(operation))
        {
            capture.Check("dynamodb", operation, StoreClassifier.ClassifyDynamo(operation, null, treatAsRead));
            return;
        }

        if (capture.Current is { InPreview: true } preview)
        {
            var unseen = new Unseen(operation);
            ((UnseenRequests)preview.State.GetOrAdd(this, _ => new UnseenRequests())).Requests.Enqueue(unseen);
            _unseen.Value = unseen;
        }
    }

    /// <summary>The PartiQL requests of a Preview that ran through a client the pipeline handler isn't installed on.</summary>
    internal IEnumerable<string> UnseenIn(SendproofPreview preview) =>
        preview.State.TryGetValue(this, out var value) ? ((UnseenRequests)value).Requests.Where(item => !item.Seen).Select(item => item.Operation) : [];

    private sealed class GuardTracerProvider(DynamoGuard guard, TracerProvider inner) : TracerProvider
    {
        internal DynamoGuard Guard => guard;

        internal TracerProvider Inner => inner;

        public override Tracer GetTracer(string scope) => Wrap(scope, inner.GetTracer(scope));

        public override Tracer GetTracer(string scope, Attributes attributes) => Wrap(scope, inner.GetTracer(scope, attributes));

        private Tracer Wrap(string scope, Tracer tracer) => scope == TracerScope ? new GuardTracer(guard, tracer) : tracer;
    }

    private sealed class GuardTracer(DynamoGuard guard, Tracer inner) : Tracer
    {
        public override TraceSpan CreateSpan(string name, Attributes? initialAttributes = null, SpanKind spanKind = SpanKind.INTERNAL, SpanContext? parentContext = null)
        {
            guard.BeforeSend(name);
            return inner.CreateSpan(name, initialAttributes, spanKind, parentContext);
        }
    }

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
        if (_unseen.Value is { } unseen)
        {
            // The request the tracer opened a span for reached the handler: its statements are checked here.
            unseen.Seen = true;
            _unseen.Value = null;
        }

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
