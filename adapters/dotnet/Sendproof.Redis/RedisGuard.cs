using System.Diagnostics;
using System.Reflection;
using Sendproof.AspNetCore;
using StackExchange.Redis;

namespace Sendproof.Redis;

/// <summary>
/// The Redis write guard. <see cref="Guard"/> wraps a <see cref="IConnectionMultiplexer"/> so that every database,
/// batch, transaction, server and subscriber handle it hands out checks each call before it is sent: during a Preview a
/// write (by the shared table in spec/data-stores/redis.json) is refused with
/// <see cref="PreviewWriteBlockedException"/> and blocks the Preview; reads run and are logged as <c>Db</c> entries.
/// </summary>
/// <remarks>
/// Commands are checked when they are issued, not when a batch or transaction executes, so a refused write is never
/// queued and never sent. Anything the library adds later that the map doesn't know is a write, so the guard fails closed.
/// A multiplexer the application created some other way, or a second connection, is not covered.
/// </remarks>
internal sealed class RedisGuard(CaptureContext capture, IReadOnlySet<string>? treatAsRead)
{
    private readonly CaptureContext capture = capture;
    private readonly IReadOnlySet<string>? treatAsRead = treatAsRead;

    /// <summary>Wraps a multiplexer in a guarded decorator.</summary>
    internal IConnectionMultiplexer Guard(IConnectionMultiplexer inner) => Create<IConnectionMultiplexer>(inner, Kind.Multiplexer, 0, null);

    private T Create<T>(object inner, Kind kind, int database, IConnectionMultiplexer? multiplexer) where T : class
    {
        var proxy = DispatchProxy.Create<T, GuardProxy>();
        // Every handle reports the guarded multiplexer as its own, so handle.Multiplexer never reaches the real connection.
        ((GuardProxy)(object)proxy).Initialize(this, inner, kind, database, multiplexer ?? (IConnectionMultiplexer)(object)proxy);
        return proxy;
    }

    internal enum Kind { Multiplexer, Database, Batch, Server, Subscriber }

    /// <summary>The proxy behind every guarded handle. DispatchProxy needs a non-sealed class.</summary>
    internal class GuardProxy : DispatchProxy
    {
        private RedisGuard _guard = null!;
        private object _inner = null!;
        private Kind _kind;
        private int _database;
        private IConnectionMultiplexer _multiplexer = null!;

        internal void Initialize(RedisGuard guard, object inner, Kind kind, int database, IConnectionMultiplexer multiplexer)
        {
            _guard = guard;
            _inner = inner;
            _kind = kind;
            _database = database;
            _multiplexer = multiplexer;
        }

        protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
        {
            var method = targetMethod!;
            var arguments = args ?? [];
            if (_kind == Kind.Multiplexer)
            {
                return InvokeMultiplexer(method, arguments);
            }

            if (method.Name == "get_Multiplexer")
            {
                return _multiplexer;
            }

            // Properties, connection details and disposal describe the handle; they send no command.
            if (method.IsSpecialName || RedisCommandMap.IsNotACommand(method.Name))
            {
                return Call(method, arguments);
            }

            if (RedisCommandMap.CreatesBatch(method.Name))
            {
                var batch = Call(method, arguments)!;
                return method.ReturnType == typeof(ITransaction)
                    ? _guard.Create<ITransaction>(batch, Kind.Batch, _database, _multiplexer)
                    : _guard.Create<IBatch>(batch, Kind.Batch, _database, _multiplexer);
            }

            if (_kind == Kind.Batch && method.Name is "Execute" or "ExecuteAsync" && method.DeclaringType != typeof(IDatabaseAsync) &&
                arguments.All(argument => argument is CommandFlags))
            {
                // Run the queued commands: each was checked when it was queued, so nothing here can write.
                return Call(method, arguments);
            }

            return _guard.Run(method, arguments, _inner, _database, _kind == Kind.Subscriber);
        }

        private object? InvokeMultiplexer(MethodInfo method, object?[] arguments)
        {
            if (method.Name is "PublishReconfigure" or "PublishReconfigureAsync")
            {
                // Publishes to the configuration channel, which every connected client acts on: a write like PUBLISH.
                try
                {
                    _guard.capture.Check("redis", "PUBLISH", StoreClassifier.ClassifyRedis("PUBLISH", null, _guard.treatAsRead));
                }
                catch (PreviewWriteBlockedException error)
                {
                    if (TaskFault.Create(method.ReturnType, error) is { } fault) return fault;
                    throw;
                }
            }

            var result = Call(method, arguments);
            var self = (IConnectionMultiplexer)(object)this;
            switch (method.Name)
            {
                case "GetDatabase":
                    var database = result as IDatabase;
                    return _guard.Create<IDatabase>(result!, Kind.Database, database?.Database ?? -1, self);
                case "GetServer":
                    return _guard.Create<IServer>(result!, Kind.Server, 0, self);
                case "GetServers":
                    return ((IServer[])result!).Select(server => _guard.Create<IServer>(server, Kind.Server, 0, self)).ToArray();
                case "GetSubscriber":
                    return _guard.Create<ISubscriber>(result!, Kind.Subscriber, 0, self);
                default:
                    return result;
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

    /// <summary>Checks one command, runs it on the real handle and logs it as a <c>Db</c> entry.</summary>
    private object? Run(MethodInfo method, object?[] arguments, object inner, int database, bool _)
    {
        var command = RedisCommandMap.Resolve(method.Name, arguments);
        var kind = StoreClassifier.ClassifyRedis(command.Name, command.Sub, treatAsRead);
        var isExecute = method.Name is "Execute" or "ExecuteAsync";
        try
        {
            capture.Check("redis", command.Name, kind);
        }
        catch (PreviewWriteBlockedException error)
        {
            // Fail the way the method fails: a faulted task for an async method, a throw for a synchronous one.
            if (TaskFault.Create(method.ReturnType, error) is { } fault) return fault;
            throw;
        }

        // Session commands (PING, AUTH) are allowed and never logged; so are commands outside any Preview or send.
        var recorder = kind == CommandKind.Session ? null : capture.Current;
        if (recorder is null)
        {
            return Invoke(method, inner, arguments);
        }

        var (statement, target) = isExecute ? RedisCommandMap.DescribeExecute(command, arguments) : RedisCommandMap.Describe(command, arguments);
        var entry = new DbEntry("redis", command.Name) { Target = target, Namespace = database < 0 ? null : database.ToString(System.Globalization.CultureInfo.InvariantCulture), Statement = statement };
        var started = Stopwatch.GetTimestamp();
        object? result;
        try
        {
            result = Invoke(method, inner, arguments);
        }
        catch (Exception error)
        {
            recorder.RecordDb(entry with { Error = ErrorName(error), ElapsedMs = Stopwatch.GetElapsedTime(started).TotalMilliseconds });
            throw;
        }

        if (method.ReturnType == typeof(Task))
        {
            return ObserveTask((Task)result!, recorder, entry, started);
        }

        if (method.ReturnType.IsGenericType && method.ReturnType.GetGenericTypeDefinition() == typeof(Task<>))
        {
            return ObserveGeneric.MakeGenericMethod(method.ReturnType.GetGenericArguments()[0]).Invoke(null, [result, recorder, entry, started]);
        }

        recorder.RecordDb(entry with { ElapsedMs = Stopwatch.GetElapsedTime(started).TotalMilliseconds });
        return result;
    }

    private static object? Invoke(MethodInfo method, object inner, object?[] arguments)
    {
        try
        {
            return method.Invoke(inner, arguments);
        }
        catch (TargetInvocationException error) when (error.InnerException is not null)
        {
            System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(error.InnerException).Throw();
            throw;
        }
    }

    private static string ErrorName(Exception error) => error is RedisServerException server && server.Message.Split(' ', 2)[0] is { Length: > 0 } code
        ? code
        : error.GetType().Name;

    private static readonly MethodInfo ObserveGeneric = typeof(RedisGuard).GetMethod(nameof(ObserveTyped), BindingFlags.Static | BindingFlags.NonPublic)!;

    private static async Task ObserveTask(Task task, SendproofPreview recorder, DbEntry entry, long started)
    {
        try
        {
            await task.ConfigureAwait(false);
            recorder.RecordDb(entry with { ElapsedMs = Stopwatch.GetElapsedTime(started).TotalMilliseconds });
        }
        catch (Exception error)
        {
            recorder.RecordDb(entry with { Error = ErrorName(error), ElapsedMs = Stopwatch.GetElapsedTime(started).TotalMilliseconds });
            throw;
        }
    }

    private static async Task<T> ObserveTyped<T>(Task<T> task, SendproofPreview recorder, DbEntry entry, long started)
    {
        try
        {
            var result = await task.ConfigureAwait(false);
            recorder.RecordDb(entry with { ElapsedMs = Stopwatch.GetElapsedTime(started).TotalMilliseconds });
            return result;
        }
        catch (Exception error)
        {
            recorder.RecordDb(entry with { Error = ErrorName(error), ElapsedMs = Stopwatch.GetElapsedTime(started).TotalMilliseconds });
            throw;
        }
    }
}
