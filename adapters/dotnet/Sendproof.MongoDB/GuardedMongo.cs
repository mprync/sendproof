using System.Reflection;
using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using MongoDB.Driver;
using Sendproof.AspNetCore;

namespace Sendproof.MongoDB;

/// <summary>
/// Guarded handles for the MongoDB .NET driver. No driver offers a pre-send hook, so a guarded client hands out guarded
/// databases, collections and index managers with the driver's own API. During a Preview each call is checked before the
/// driver builds a command:
/// <list type="bullet">
/// <item>a call without a session is routed to its session overload with the Preview session, so the command carries the
/// Preview's <c>lsid</c>, <c>txnNumber</c> and <c>autocommit: false</c>;</item>
/// <item>an explicit session other than the Preview's is refused and fails the Preview with 500;</item>
/// <item>the guard classifies the command the method sends and blocks writes (<c>guard</c> mode) or what a transaction can't
/// run (<c>preview</c> mode);</item>
/// <item>a method the rules don't know is refused, so a new driver method fails closed;</item>
/// <item>an aggregation's stages are rendered and checked when it runs, so a stage added through the fluent builder
/// (<c>.Out()</c>, <c>.Merge()</c>) can't slip a write past the guard.</item>
/// </list>
/// Outside a Preview every call passes straight through.
/// </summary>
internal class GuardedMongo : DispatchProxy
{
    /// <summary>Which driver interface a proxy stands for.</summary>
    internal enum Kind { Client, Database, Collection, Indexes, Refused }

    /// <summary>Builds a command document for the guard to classify, from a call's arguments.</summary>
    private delegate BsonDocument Rule(object?[] arguments, string collection);

    private MongoEngine _engine = null!;
    private object _inner = null!;
    private Kind _kind;
    private string? _database;
    private string _collection = "";

    /// <summary>Wraps a driver handle in a guarded proxy of the given interface type.</summary>
    internal static T Wrap<T>(MongoEngine engine, T inner, Kind kind, string? database = null, string collection = "") where T : class =>
        (T)Wrap(engine, typeof(T), inner, kind, database, collection);

    private static object Wrap(MongoEngine engine, Type interfaceType, object inner, Kind kind, string? database, string collection)
    {
        var proxy = Create(interfaceType, typeof(GuardedMongo));
        var guarded = (GuardedMongo)proxy;
        (guarded._engine, guarded._inner, guarded._kind, guarded._database, guarded._collection) = (engine, inner, kind, database, collection);
        return proxy;
    }

    // ---- The rules: which command each driver method sends ----

    private static Rule Simple(string command) => (_, collection) => new BsonDocument(command, collection);

    private static Rule Pipeline(string scope) => (arguments, collection) => new BsonDocument
    {
        { "aggregate", scope == "collection" ? new BsonString(collection) : new BsonInt32(1) }, { "pipeline", Stages(arguments) }
    };

    private static readonly Dictionary<string, Rule> CollectionRules = new(StringComparer.Ordinal)
    {
        ["InsertOne"] = Simple("insert"), ["InsertMany"] = Simple("insert"), ["BulkWrite"] = Simple("bulkWrite"),
        ["UpdateOne"] = Simple("update"), ["UpdateMany"] = Simple("update"), ["ReplaceOne"] = Simple("update"),
        ["DeleteOne"] = Simple("delete"), ["DeleteMany"] = Simple("delete"),
        ["FindOneAndDelete"] = Simple("findAndModify"), ["FindOneAndReplace"] = Simple("findAndModify"), ["FindOneAndUpdate"] = Simple("findAndModify"),
        ["Find"] = Simple("find"), ["FindSync"] = Simple("find"),
        ["CountDocuments"] = (_, collection) => new BsonDocument { { "aggregate", collection }, { "pipeline", new BsonArray() } },
        ["EstimatedDocumentCount"] = Simple("count"), ["Count"] = Simple("count"),
        ["Distinct"] = Simple("distinct"), ["DistinctMany"] = Simple("distinct"),
        ["Aggregate"] = Pipeline("collection"), ["AggregateToCollection"] = Pipeline("collection"),
        ["Watch"] = (arguments, collection) => new BsonDocument
        {
            { "aggregate", collection }, { "pipeline", new BsonArray { new BsonDocument("$changeStream", new BsonDocument()) } }
        },
        ["MapReduce"] = Simple("mapReduce"),
    };

    private static readonly Dictionary<string, Rule> DatabaseRules = new(StringComparer.Ordinal)
    {
        ["RunCommand"] = (arguments, _) => RenderedCommand(arguments),
        ["Aggregate"] = Pipeline("database"), ["AggregateToCollection"] = Pipeline("database"),
        ["CreateCollection"] = (arguments, _) => new BsonDocument("create", arguments.OfType<string>().FirstOrDefault() ?? ""),
        ["CreateView"] = (arguments, _) => new BsonDocument("create", arguments.OfType<string>().FirstOrDefault() ?? ""),
        ["DropCollection"] = (arguments, _) => new BsonDocument("drop", arguments.OfType<string>().FirstOrDefault() ?? ""),
        ["RenameCollection"] = (arguments, _) => new BsonDocument("renameCollection", arguments.OfType<string>().FirstOrDefault() ?? ""),
        ["ListCollections"] = (_, _) => new BsonDocument("listCollections", 1), ["ListCollectionNames"] = (_, _) => new BsonDocument("listCollections", 1),
        ["Watch"] = (_, _) => new BsonDocument { { "aggregate", 1 }, { "pipeline", new BsonArray { new BsonDocument("$changeStream", new BsonDocument()) } } },
    };

    private static readonly Dictionary<string, Rule> ClientRules = new(StringComparer.Ordinal)
    {
        // Client-level commands address user databases, so they join the transaction.
        ["BulkWrite"] = (_, _) => new BsonDocument("bulkWrite", 1),
        ["Watch"] = (_, _) => new BsonDocument { { "aggregate", 1 }, { "pipeline", new BsonArray { new BsonDocument("$changeStream", new BsonDocument()) } } },
        ["DropDatabase"] = (_, _) => new BsonDocument("dropDatabase", 1),
        ["ListDatabases"] = (_, _) => new BsonDocument("listDatabases", 1), ["ListDatabaseNames"] = (_, _) => new BsonDocument("listDatabases", 1),
    };

    private static readonly Dictionary<string, Rule> IndexRules = new(StringComparer.Ordinal)
    {
        ["CreateOne"] = Simple("createIndexes"), ["CreateMany"] = Simple("createIndexes"),
        ["DropOne"] = Simple("dropIndexes"), ["DropAll"] = Simple("dropIndexes"),
        ["List"] = Simple("listIndexes"),
    };

    /// <summary>The reason a Preview blocks direct access to the client's cluster.</summary>
    internal const string ClusterReason = "Preview unavailable: GridFS and other direct cluster access can't join the Preview's MongoDB session";

    /// <summary>Methods that return another handle: they are wrapped, never guarded.</summary>
    private static bool ReturnsHandle(string name) => name is "GetDatabase" or "GetCollection" or "WithReadConcern" or "WithReadPreference" or "WithWriteConcern" or "OfType";

    // ---- The call ----

    protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
    {
        var method = targetMethod!;
        var arguments = args ?? [];
        var capture = _engine.Capture;
        var preview = capture.Current is { InPreview: true } current ? current : null;
        var baseName = BaseName(method.Name);

        if (_kind == Kind.Client && method.Name == "Dispose" && ReferenceEquals(_inner, _engine.Client))
        {
            // The decorator owns both the instrumented client and the one the host registered.
            _engine.DisposeClients();
            return null;
        }

        if (preview is not null && _kind == Kind.Client && method.Name == "get_Cluster")
        {
            // The cluster sends commands with no session and no guard (GridFS works this way): block before anything is sent.
            capture.Check("mongodb", "Cluster", CommandKind.Write, ClusterReason);
        }

        // Properties and handle factories: wrap what they return, so a collection fetched once keeps its guard.
        if (method.IsSpecialName || ReturnsHandle(method.Name) || _kind != Kind.Refused && method.Name == "Dispose")
        {
            return Rewrap(method, Call(method, arguments));
        }

        if (preview is null)
        {
            return Rewrap(method, Call(method, arguments));
        }

        var state = _engine.StateOf(preview);
        if (_kind == Kind.Client && baseName == "StartSession")
        {
            if (state is not null)
            {
                return AsResult(method.ReturnType, state.Handle!);
            }

            // In guard mode there is no transaction to join; a handler may start its own session.
            return Rewrap(method, Call(method, arguments));
        }

        try
        {
            var rules = _kind switch
            {
                Kind.Client => ClientRules,
                Kind.Database => DatabaseRules,
                Kind.Collection => CollectionRules,
                Kind.Indexes => IndexRules,
                _ => null
            };
            if (rules is null || !rules.TryGetValue(baseName, out var rule))
            {
                // A method this guard doesn't know: refuse it in a Preview rather than let it escape.
                capture.Check("mongodb", method.Name, CommandKind.Write, MongoEngine.RefusedReason(method.Name));
                throw new InvalidOperationException("unreachable");
            }

            var operation = rule(arguments, _collection);
            var name = operation.GetElement(0).Name;
            _engine.Check(operation, name, _database);
            if (state is null || MongoEngine.IsSystemDatabase(_database))
            {
                return Call(method, arguments);
            }

            return CallInSession(method, arguments, state, preview);
        }
        catch (Exception error) when (error is PreviewWriteBlockedException or PreviewTransactionControlException)
        {
            // Fail the way the method fails: a faulted task for an async method, a throw for the rest.
            if (TaskFault.Create(method.ReturnType, error) is { } faulted)
            {
                return faulted;
            }

            throw;
        }
    }

    /// <summary>Calls the method's session overload with the Preview session, or refuses a foreign session.</summary>
    private object? CallInSession(MethodInfo method, object?[] arguments, MongoEngine.PreviewState state, SendproofPreview preview)
    {
        var parameters = method.GetParameters();
        if (parameters.Length > 0 && parameters[0].ParameterType == typeof(IClientSessionHandle))
        {
            var given = arguments[0] as IClientSessionHandle;
            if (given is not null && !ReferenceEquals(given, state.Handle) && !ReferenceEquals(given, state.Session))
            {
                var error = _engine.Capture.RefuseInPreview("A MongoDB call passed its own session during a Preview; the Preview session must carry every command.")!;
                throw error;
            }

            var withReal = (object?[])arguments.Clone();
            withReal[0] = state.Session;
            return Rewrap(method, Call(method, withReal));
        }

        var overload = SessionOverload(method);
        if (overload is null)
        {
            // Nothing carries the Preview session for this call: refuse rather than send it outside the transaction.
            _engine.Capture.Check("mongodb", method.Name, CommandKind.Write, MongoEngine.RefusedReason(method.Name));
            throw new InvalidOperationException("unreachable");
        }

        var call = new object?[overload.Types.Length + 1];
        call[0] = state.Session;
        for (var index = 0; index < overload.Types.Length; index++)
        {
            call[index + 1] = overload.Map[index] >= 0
                ? arguments[overload.Map[index]]
                : overload.Types[index].IsValueType ? Activator.CreateInstance(overload.Types[index]) : null;
        }

        return Rewrap(method, Call(overload.Method, call));
    }

    /// <summary>A session overload of a driver method, and which of the call's arguments fill its parameters (-1: a default).</summary>
    private sealed record Overload(MethodInfo Method, Type[] Types, int[] Map);

    private static readonly Dictionary<MethodInfo, Overload?> Overloads = [];

    /// <summary>
    /// Finds the overload of a method that takes the session first and then the same arguments. A convenience overload
    /// without its options (<c>DeleteOne(filter, ct)</c>) maps to the session overload that has them
    /// (<c>DeleteOne(session, filter, options, ct)</c>), the missing optional parameters taking their defaults.
    /// </summary>
    private static Overload? SessionOverload(MethodInfo method)
    {
        lock (Overloads)
        {
            if (Overloads.TryGetValue(method, out var cached))
            {
                return cached;
            }

            var wanted = method.GetParameters().Select(parameter => parameter.ParameterType).ToArray();
            Overload? found = null;
            foreach (var candidate in method.DeclaringType!.GetMethods().Where(item => item.Name == method.Name))
            {
                if (candidate.IsGenericMethodDefinition != method.IsGenericMethod)
                {
                    continue;
                }

                var closed = candidate.IsGenericMethodDefinition ? candidate.MakeGenericMethod(method.GetGenericArguments()) : candidate;
                var parameters = closed.GetParameters();
                if (parameters.Length < 2 || parameters[0].ParameterType != typeof(IClientSessionHandle))
                {
                    continue;
                }

                var map = new int[parameters.Length - 1];
                var next = 0;
                var fits = true;
                for (var index = 1; index < parameters.Length && fits; index++)
                {
                    if (next < wanted.Length && parameters[index].ParameterType == wanted[next])
                    {
                        map[index - 1] = next++;
                    }
                    else if (parameters[index].IsOptional)
                    {
                        map[index - 1] = -1;
                    }
                    else
                    {
                        fits = false;
                    }
                }

                if (fits && next == wanted.Length && (found is null || map.Count(slot => slot < 0) < found.Map.Count(slot => slot < 0)))
                {
                    found = new Overload(closed, [.. parameters.Skip(1).Select(parameter => parameter.ParameterType)], map);
                }
            }

            return Overloads[method] = found;
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

    /// <summary>Wraps a handle a driver method returned (a database, a collection, an index manager) so it stays guarded.</summary>
    private object? Rewrap(MethodInfo method, object? result)
    {
        if (result is null)
        {
            return null;
        }

        var type = method.ReturnType;
        if (type == typeof(IMongoClient) && _kind == Kind.Database)
        {
            // collection.Database.Client: hand back the guarded client, not the instrumented one.
            return _engine.GuardedClient ?? result;
        }

        if (type == typeof(IMongoClient) && _kind == Kind.Client)
        {
            // client.WithReadPreference(...) and the other With* copies: a new client with other options, guarded too.
            return Wrap(_engine, type, result, Kind.Client, null, "");
        }

        if (type == typeof(IMongoDatabase))
        {
            return Wrap(_engine, type, result, Kind.Database, ((IMongoDatabase)result).DatabaseNamespace.DatabaseName, "");
        }

        if (type.IsGenericType && typeof(IMongoCollection<>).MakeGenericType(type.GetGenericArguments()[0]).IsAssignableFrom(type))
        {
            // Read through the public interface: the driver's own collection class is internal, which dynamic can't see.
            var collection = (CollectionNamespace)type.GetProperty(nameof(IMongoCollection<BsonDocument>.CollectionNamespace))!.GetValue(result)!;
            return Wrap(_engine, type, result, Kind.Collection, collection.DatabaseNamespace.DatabaseName, collection.CollectionName);
        }

        if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(IMongoIndexManager<>))
        {
            return Wrap(_engine, type, result, Kind.Indexes, _database, _collection);
        }

        if (type.FullName == "MongoDB.Driver.Search.IMongoSearchIndexManager")
        {
            return Wrap(_engine, type, result, Kind.Refused, _database, _collection);
        }

        return result;
    }

    /// <summary>A completed task or a plain value, whichever the method returns.</summary>
    private static object AsResult(Type returnType, object value) =>
        TaskFault.IsTask(returnType)
            ? typeof(Task).GetMethod(nameof(Task.FromResult))!.MakeGenericMethod(returnType.GetGenericArguments()[0]).Invoke(null, [value])!
            : value;

    private static string BaseName(string name) => name.EndsWith("Async", StringComparison.Ordinal) ? name[..^5] : name;

    // ---- Rendering what the driver would send ----

    /// <summary>The pipeline stages of an aggregate call, rendered; one the guard can't render is treated as writing.</summary>
    private static BsonArray Stages(object?[] arguments)
    {
        try
        {
            var pipeline = arguments.FirstOrDefault(argument => argument is not null && IsPipeline(argument.GetType()));
            if (pipeline is null)
            {
                return [];
            }

            var definition = BaseDefinition(pipeline.GetType(), typeof(PipelineDefinition<,>))!;
            var input = definition.GetGenericArguments()[0];
            var serializer = input == typeof(NoPipelineInput) ? NoInputSerializer : BsonSerializer.LookupSerializer(input);
            var renderArgs = Activator.CreateInstance(typeof(RenderArgs<>).MakeGenericType(input),
                [serializer, BsonSerializer.SerializerRegistry, default(PathRenderArgs), false, false, false, null])!;
            // Call the public base type's Render: the concrete pipeline classes are internal to the driver.
            var rendered = definition.GetMethod("Render")!.Invoke(pipeline, [renderArgs])!;
            return new BsonArray((IEnumerable<BsonDocument>)rendered.GetType().GetProperty("Documents")!.GetValue(rendered)!);
        }
        catch (Exception error) when (error is not OutOfMemoryException)
        {
            // Can't see inside it, so assume the worst: a stage that writes.
            return new BsonArray { new BsonDocument("$out", "?") };
        }
    }

    // The driver's serializer for a pipeline that has no input document (a database-level aggregate) is internal.
    private static readonly object NoInputSerializer = typeof(IMongoClient).Assembly.GetType("MongoDB.Driver.NoPipelineInputSerializer")!
        .GetProperty("Instance", BindingFlags.Public | BindingFlags.Static)!.GetValue(null)!;

    /// <summary>The constructed base type of <paramref name="type"/> that is an instance of an open generic type, if any.</summary>
    private static Type? BaseDefinition(Type type, Type openGeneric)
    {
        for (var current = type; current is not null; current = current.BaseType)
        {
            if (current.IsGenericType && current.GetGenericTypeDefinition() == openGeneric)
            {
                return current;
            }
        }

        return null;
    }

    private static bool IsPipeline(Type type) => BaseDefinition(type, typeof(PipelineDefinition<,>)) is not null;

    private static bool IsCommand(Type type) => BaseDefinition(type, typeof(Command<>)) is not null;

    /// <summary>The command document of a <c>RunCommand</c> call.</summary>
    private static BsonDocument RenderedCommand(object?[] arguments)
    {
        try
        {
            var command = arguments.First(argument => argument is not null && IsCommand(argument.GetType()));
            var rendered = BaseDefinition(command!.GetType(), typeof(Command<>))!.GetMethod("Render")!.Invoke(command, [BsonSerializer.SerializerRegistry])!;
            return (BsonDocument)rendered.GetType().GetProperty("Document")!.GetValue(rendered)!;
        }
        catch (Exception error) when (error is not OutOfMemoryException)
        {
            return new BsonDocument("runCommand", 1);
        }
    }
}
