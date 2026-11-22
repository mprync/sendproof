using System.Reflection;
using Google.Cloud.Firestore;
using Google.Cloud.Firestore.V1;
using Google.Protobuf;
using Grpc.Core;
using Grpc.Core.Interceptors;
using Sendproof.AspNetCore;

namespace Sendproof.Firestore;

/// <summary>
/// The Firestore write guard: a gRPC client <see cref="Interceptor"/> on the call invoker that <see cref="FirestoreClient"/>
/// sends through. It overrides every call type, because <c>RunQuery</c>, <c>BatchGetDocuments</c> and <c>Listen</c> stream and
/// <c>Write</c> is a bidirectional stream that must be refused before its first message: an interceptor that only handled
/// unary calls would let <c>Write</c> through. The RPC is the method name of the call, and a <c>Commit</c> is a write when its
/// request carries at least one write. Classification follows spec/data-stores/firestore.json.
/// </summary>
internal sealed class FirestoreGuard(CaptureContext capture, IReadOnlySet<string>? treatAsRead)
{
    /// <summary>The store id in <c>Db</c> entries and the 409 body.</summary>
    internal const string Store = "firestore";

    /// <summary>Creates the interceptor that checks each call before it is sent.</summary>
    internal Interceptor CreateInterceptor() => new GuardInterceptor(this);

    /// <summary>Puts the interceptor in front of a call invoker.</summary>
    internal CallInvoker Guard(CallInvoker invoker) => invoker.Intercept(CreateInterceptor());

    private static readonly PropertyInfo? CallInvokerProperty = typeof(ClientBase).GetProperty(
        "CallInvoker", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);

    /// <summary>
    /// The call invoker a client sends through. It sits in a protected property of the generated gRPC client, which a
    /// <see cref="FirestoreClient"/> built by a <see cref="FirestoreClientBuilder"/> wraps; a client the guard can't read
    /// it from is refused rather than assumed guarded.
    /// </summary>
    internal static CallInvoker InvokerOf(FirestoreClient client) =>
        CallInvokerProperty?.GetValue(client.GrpcClient) as CallInvoker ??
        throw new InvalidOperationException("Sendproof can't read this FirestoreClient's gRPC call invoker, so it can't guard it. Build the client with a guarded CallInvoker instead.");

    private static readonly FieldInfo? ClientField = typeof(FirestoreDb).GetField("<Client>k__BackingField", BindingFlags.Instance | BindingFlags.NonPublic);

    private static readonly MethodInfo CloneMethod = typeof(object).GetMethod("MemberwiseClone", BindingFlags.Instance | BindingFlags.NonPublic)!;

    /// <summary>
    /// A database equal to <paramref name="db"/> in every setting (project, database id, converters, retry settings) that sends
    /// through <paramref name="client"/>. The public <c>FirestoreDb.Create</c> only builds the default database, so the copy is
    /// made by cloning the original and replacing its client; where that isn't possible a default database is created through
    /// the public API and any other database is refused rather than left unguarded.
    /// </summary>
    internal static FirestoreDb WithClient(FirestoreDb db, FirestoreClient client)
    {
        if (ClientField is not null && CloneMethod.Invoke(db, null) is FirestoreDb copy)
        {
            ClientField.SetValue(copy, client);
            return copy;
        }

        return db.DatabaseId == "(default)"
            ? FirestoreDb.Create(db.ProjectId, client)
            : throw new InvalidOperationException(
                $"Sendproof can't guard the Firestore database '{db.DatabaseId}' with this version of Google.Cloud.Firestore. Update Sendproof.Firestore.");
    }

    /// <summary>Whether a database sends through this guard's interceptor.</summary>
    internal bool IsGuarded(FirestoreDb db) => _guardedDatabases.TryGetValue(db, out _);

    // The databases this guard created. The client builder may wrap the invoker again, so the database is the marker.
    private readonly System.Runtime.CompilerServices.ConditionalWeakTable<FirestoreDb, object> _guardedDatabases = new();

    /// <summary>Records a database this guard created, so guarding it again changes nothing.</summary>
    internal FirestoreDb Mark(FirestoreDb guarded)
    {
        _guardedDatabases.Add(guarded, this);
        return guarded;
    }

    private sealed class GuardInterceptor(FirestoreGuard guard) : Interceptor
    {
        public override TResponse BlockingUnaryCall<TRequest, TResponse>(TRequest request, ClientInterceptorContext<TRequest, TResponse> context,
            BlockingUnaryCallContinuation<TRequest, TResponse> continuation)
        {
            var call = guard.Begin(context.Method.FullName, request);
            try
            {
                var response = continuation(request, context);
                call.Succeed();
                return response;
            }
            catch (Exception error)
            {
                call.Fail(error, Code(error));
                throw;
            }
        }

        public override AsyncUnaryCall<TResponse> AsyncUnaryCall<TRequest, TResponse>(TRequest request, ClientInterceptorContext<TRequest, TResponse> context,
            AsyncUnaryCallContinuation<TRequest, TResponse> continuation)
        {
            var call = guard.Begin(context.Method.FullName, request);
            var inner = continuation(request, context);
            return new AsyncUnaryCall<TResponse>(Observe(inner.ResponseAsync, call), inner.ResponseHeadersAsync, inner.GetStatus, inner.GetTrailers, inner.Dispose);
        }

        // A streaming call is logged when it starts: its rows arrive over time, and the guard never reads them.
        public override AsyncServerStreamingCall<TResponse> AsyncServerStreamingCall<TRequest, TResponse>(TRequest request, ClientInterceptorContext<TRequest, TResponse> context,
            AsyncServerStreamingCallContinuation<TRequest, TResponse> continuation)
        {
            var call = guard.Begin(context.Method.FullName, request);
            var inner = continuation(request, context);
            call.Succeed();
            return inner;
        }

        public override AsyncClientStreamingCall<TRequest, TResponse> AsyncClientStreamingCall<TRequest, TResponse>(ClientInterceptorContext<TRequest, TResponse> context,
            AsyncClientStreamingCallContinuation<TRequest, TResponse> continuation)
        {
            var call = guard.Begin(context.Method.FullName, null);
            var inner = continuation(context);
            call.Succeed();
            return inner;
        }

        public override AsyncDuplexStreamingCall<TRequest, TResponse> AsyncDuplexStreamingCall<TRequest, TResponse>(ClientInterceptorContext<TRequest, TResponse> context,
            AsyncDuplexStreamingCallContinuation<TRequest, TResponse> continuation)
        {
            // Write is refused here, before its first message; Listen is a read.
            var call = guard.Begin(context.Method.FullName, null);
            var inner = continuation(context);
            call.Succeed();
            return inner;
        }

        private static async Task<TResponse> Observe<TResponse>(Task<TResponse> task, DbCall call)
        {
            try
            {
                var response = await task.ConfigureAwait(false);
                call.Succeed();
                return response;
            }
            catch (Exception error)
            {
                call.Fail(error, Code(error));
                throw;
            }
        }

        private static string Code(Exception error) => error is RpcException rpc ? rpc.StatusCode.ToString() : error.GetType().Name;
    }

    /// <summary>Checks one call before it is sent: classifies the RPC (and a <c>Commit</c>'s writes) and refuses a write in a Preview.</summary>
    private DbCall Begin(string rpc, object? message)
    {
        int? writeCount = message is null ? null : message is CommitRequest commit ? commit.Writes.Count : 0;
        // A Commit whose message the guard can't read (a streaming call has none) is a write.
        var classification = FirestoreClassifier.Classify(rpc, rpc.EndsWith("/Commit", StringComparison.Ordinal) ? writeCount : null);
        if (classification.Kind == CommandKind.Write && treatAsRead?.Contains(classification.Operation) == true)
        {
            classification = classification with { Kind = CommandKind.Read };
        }

        return DbCall.Begin(capture, Store, classification, () => new DbEntry(Store, classification.Operation)
        {
            Target = CollectionOf(message),
            Statement = message is IMessage proto ? StatementShape.RedactJson(JsonFormatter.Default.Format(proto)) : null
        });
    }

    /// <summary>The collection a request names, for <c>db.collection.name</c>: from the query, the document path or the writes.</summary>
    private static string? CollectionOf(object? message) => message switch
    {
        RunQueryRequest query => query.StructuredQuery?.From.FirstOrDefault()?.CollectionId,
        RunAggregationQueryRequest aggregation => aggregation.StructuredAggregationQuery?.StructuredQuery?.From.FirstOrDefault()?.CollectionId,
        PartitionQueryRequest partition => partition.StructuredQuery?.From.FirstOrDefault()?.CollectionId,
        BatchGetDocumentsRequest batch => CollectionOfName(batch.Documents.FirstOrDefault()),
        GetDocumentRequest get => CollectionOfName(get.Name),
        ListDocumentsRequest list => list.CollectionId,
        CreateDocumentRequest create => create.CollectionId,
        UpdateDocumentRequest update => CollectionOfName(update.Document?.Name),
        DeleteDocumentRequest delete => CollectionOfName(delete.Name),
        CommitRequest commit => commit.Writes.FirstOrDefault() is { } write ? CollectionOfName(write.Update?.Name ?? write.Delete ?? write.Transform?.Document) : null,
        BatchWriteRequest batch => batch.Writes.FirstOrDefault() is { } write ? CollectionOfName(write.Update?.Name ?? write.Delete ?? write.Transform?.Document) : null,
        _ => null
    };

    /// <summary>The collection id of a document or collection path: <c>…/documents/orders/o-1</c> is <c>orders</c>.</summary>
    private static string? CollectionOfName(string? name)
    {
        if (name is null)
        {
            return null;
        }

        var marker = name.IndexOf("/documents/", StringComparison.Ordinal);
        if (marker < 0)
        {
            return null;
        }

        var segments = name[(marker + "/documents/".Length)..].Split('/', StringSplitOptions.RemoveEmptyEntries);
        return segments.Length == 0 ? null : segments.Length % 2 == 0 ? segments[^2] : segments[^1];
    }
}
