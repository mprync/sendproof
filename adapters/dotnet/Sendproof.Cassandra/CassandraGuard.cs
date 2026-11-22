using System.Reflection;
using Cassandra;
using Sendproof.AspNetCore;

namespace Sendproof.Cassandra;

/// <summary>
/// The Cassandra write guard. <see cref="Guard(ISession)"/> wraps a driver <see cref="ISession"/> so that every statement
/// it executes is checked before it is sent: during a Preview a write (by the shared table in
/// spec/data-stores/cassandra.json) is refused with <see cref="PreviewWriteBlockedException"/> and blocks the Preview;
/// reads run and are logged as <c>Db</c> entries with every literal replaced by <c>?</c>.
/// </summary>
/// <remarks>
/// The session, and the cluster it came from, are the driver's only public entry points: <c>ICluster.Connect</c> and
/// <c>ISession.Cluster</c> return guarded handles too, so a derived handle never escapes the guard. A bound statement
/// is classified by the text it was prepared from, so an id the guard never saw prepared can't be sent. A
/// <c>BatchStatement</c>, a graph statement and the keyspace DDL helpers are writes; a method the guard doesn't know is
/// a write, so a driver release that adds one fails closed. A session the application created some other way is not covered.
/// </remarks>
internal sealed class CassandraGuard(CaptureContext capture, IReadOnlySet<string>? treatAsRead)
{
    /// <summary>Wraps a session in a guarded decorator. A session that is already guarded by this guard is returned as it is.</summary>
    internal ISession Guard(ISession inner) =>
        inner is GuardProxy { Owner: { } owner } && ReferenceEquals(owner, this) ? inner : Create<ISession>(inner);

    /// <summary>Wraps a cluster in a guarded decorator whose sessions are guarded.</summary>
    internal ICluster Guard(ICluster inner) =>
        inner is GuardProxy { Owner: { } owner } && ReferenceEquals(owner, this) ? inner : Create<ICluster>(inner);

    private T Create<T>(T inner) where T : class
    {
        var proxy = DispatchProxy.Create<T, GuardProxy>();
        ((GuardProxy)(object)proxy).Initialize(this, inner);
        return proxy;
    }

    /// <summary>The proxy behind every guarded handle. DispatchProxy needs a non-sealed class.</summary>
    internal class GuardProxy : DispatchProxy
    {
        private CassandraGuard _guard = null!;
        private object _inner = null!;
        private ICluster? _cluster;

        internal CassandraGuard? Owner => _guard;

        internal void Initialize(CassandraGuard guard, object inner)
        {
            _guard = guard;
            _inner = inner;
        }

        protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
        {
            var method = targetMethod!;
            var arguments = args ?? [];
            return _inner is ICluster ? InvokeCluster(method, arguments) : InvokeSession(method, arguments);
        }

        private object? InvokeCluster(MethodInfo method, object?[] arguments)
        {
            var result = Call(method, arguments);
            return method.Name switch
            {
                "Connect" => _guard.Guard((ISession)result!),
                "ConnectAsync" => _guard.GuardSessionAsync((Task<ISession>)result!),
                _ => result
            };
        }

        private object? InvokeSession(MethodInfo method, object?[] arguments)
        {
            // Properties describe the session; the cluster behind it is a derived handle and stays guarded.
            if (method.IsSpecialName)
            {
                var value = Call(method, arguments);
                return method.Name == "get_Cluster" && value is ICluster cluster
                    ? _cluster ??= _guard.Guard(cluster)
                    : value;
            }

            switch (method.Name)
            {
                case "Execute" or "ExecuteAsync" or "BeginExecute":
                    return _guard.Run(method, _inner, arguments, _guard.ClassifyStatement(arguments[0]), arguments[0] as string ?? TextOf(arguments[0]));

                case "ChangeKeyspace":
                    // USE only changes the connection's keyspace: allowed and logged like a read.
                    return _guard.Run(method, _inner, arguments, CassandraClassifier.Classify("USE " + arguments[0]), "USE " + arguments[0]);

                case "CreateKeyspace" or "CreateKeyspaceIfNotExists":
                    return _guard.Run(method, _inner, arguments, new Classification(CommandKind.Write, "CREATE"), null);

                case "DeleteKeyspace" or "DeleteKeyspaceIfExists":
                    return _guard.Run(method, _inner, arguments, new Classification(CommandKind.Write, "DROP"), null);

                case "ExecuteGraph" or "ExecuteGraphAsync":
                    // DSE Graph statements can't be read and can write.
                    return _guard.Run(method, _inner, arguments, new Classification(CommandKind.Write, "GRAPH"), null);

                // PREPARE only parses a statement, so it runs; the bound statement carries the text it was prepared from.
                // The rest describe the session or collect an earlier call and send no statement.
                case "Prepare" or "PrepareAsync" or "BeginPrepare" or "EndPrepare" or "EndExecute" or "Dispose" or "ShutdownAsync"
                    or "GetMetrics" or "WaitForSchemaAgreement":
                    return Call(method, arguments);

                default:
                    // Fail closed: a method this release of the guard doesn't know could send a statement.
                    return _guard.Run(method, _inner, arguments, new Classification(CommandKind.Write, method.Name), null);
            }
        }

        private object? Call(MethodInfo method, object?[] arguments)
        {
            try
            {
                return method.Invoke(_inner, arguments);
            }
            catch (TargetInvocationException error) when (error.InnerException is not null)
            {
                System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(error.InnerException).Throw();
                throw;
            }
        }
    }

    /// <summary>The text of a statement the guard can read: simple statements by their query, bound ones by what they were prepared from.</summary>
    private static string? TextOf(object? statement) => statement switch
    {
        BoundStatement bound => bound.PreparedStatement?.QueryString,
        RegularStatement regular => regular.QueryString,
        _ => null
    };

    /// <summary>
    /// Classifies what an <c>Execute</c> call sends. A batch is always a write, even an empty one or one whose statements are
    /// prepared ids; a statement type the guard doesn't know is a write.
    /// </summary>
    private Classification ClassifyStatement(object? statement) => statement switch
    {
        string text => CassandraClassifier.Classify(text, treatAsRead),
        BatchStatement => new Classification(CommandKind.Write, "BATCH"),
        BoundStatement or RegularStatement => CassandraClassifier.Classify(TextOf(statement), treatAsRead),
        _ => new Classification(CommandKind.Write, "UNKNOWN")
    };

    private Task<ISession> GuardSessionAsync(Task<ISession> connecting) => connecting.ContinueWith(task => Guard(task.GetAwaiter().GetResult()),
        CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);

    /// <summary>Checks one call, sends it on the real session and logs it as a <c>Db</c> entry.</summary>
    private object? Run(MethodInfo method, object inner, object?[] arguments, Classification classification, string? text)
    {
        DbCall call;
        try
        {
            call = DbCall.Begin(capture, "cassandra", classification, () => new DbEntry("cassandra", classification.Operation)
            {
                Target = CassandraClassifier.Target(text),
                Namespace = (inner as ISession)?.Keyspace,
                Statement = text is null ? null : StatementShape.Redact(text)
            });
        }
        catch (PreviewWriteBlockedException error)
        {
            // Fail the way the method fails: a faulted task for an async method, a throw for a synchronous one.
            if (TaskFault.Create(method.ReturnType, error) is { } fault) return fault;
            throw;
        }

        object? result;
        try
        {
            result = method.Invoke(inner, arguments);
        }
        catch (TargetInvocationException error) when (error.InnerException is not null)
        {
            call.Fail(error.InnerException);
            System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(error.InnerException).Throw();
            throw;
        }

        switch (result)
        {
            case Task<RowSet> rows:
                return Observe(rows, call);
            case RowSet rowSet:
                call.Succeed(classification.Kind == CommandKind.Read ? rowSet.GetAvailableWithoutFetching() : null);
                return rowSet;
            default:
                call.Succeed();
                return result;
        }
    }

    private static async Task<RowSet> Observe(Task<RowSet> task, DbCall call)
    {
        try
        {
            var rows = await task.ConfigureAwait(false);
            call.Succeed(rows.GetAvailableWithoutFetching() is var count && count > 0 ? count : null);
            return rows;
        }
        catch (Exception error)
        {
            call.Fail(error);
            throw;
        }
    }
}
