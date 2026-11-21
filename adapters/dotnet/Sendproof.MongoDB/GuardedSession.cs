using System.Reflection;
using MongoDB.Driver;
using Sendproof.AspNetCore;

namespace Sendproof.MongoDB;

/// <summary>
/// The Preview session as the handler sees it. The handler's own <c>StartTransaction</c> and <c>WithTransaction</c> join the
/// Preview transaction; its <c>CommitTransaction</c> and <c>AbortTransaction</c> never reach the server, and fail the Preview
/// with 500, because a commit would persist the Preview's writes. Everything else passes to the real session.
/// </summary>
internal class GuardedSession : DispatchProxy
{
    private MongoEngine _engine = null!;
    private MongoEngine.PreviewState _state = null!;
    private SendproofPreview _preview = null!;

    /// <summary>Creates the handler's view of a Preview session.</summary>
    internal static IClientSessionHandle Create(MongoEngine engine, MongoEngine.PreviewState state, SendproofPreview preview)
    {
        var proxy = DispatchProxy.Create<IClientSessionHandle, GuardedSession>();
        var guarded = (GuardedSession)(object)proxy;
        (guarded._engine, guarded._state, guarded._preview) = (engine, state, preview);
        return proxy;
    }

    protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
    {
        var method = targetMethod!;
        var arguments = args ?? [];
        switch (method.Name)
        {
            case "StartTransaction":
                // Already inside the Preview transaction.
                return null;
            case "Dispose":
                // The Preview ends its session after the handler.
                return null;
            case "get_Client":
                // The real session's client is the instrumented one, with no guard: hand back the guarded client instead.
                return _engine.GuardedClient;
            case "CommitTransaction" or "CommitTransactionAsync" or "AbortTransaction" or "AbortTransactionAsync":
                var verb = method.Name.StartsWith("Commit", StringComparison.Ordinal) ? "commitTransaction" : "abortTransaction";
                var error = new PreviewTransactionControlException(
                    $"Preview owns the MongoDB transaction, so the handler's {verb} cannot run during Preview.");
                _preview.Refuse(error);
                return TaskFault.Create(method.ReturnType, error) ?? throw error;
            case "Fork" or "get_WrappedCoreSession":
                // Either would hand handler code the real session or a copy of it, and with it the power to commit it.
                var leak = new PreviewTransactionControlException(
                    $"Preview owns the MongoDB session, so the handler can't reach it through {method.Name.Replace("get_", "")}.");
                _preview.Refuse(leak);
                throw leak;
            case "WithTransaction" or "WithTransactionAsync":
                // The callback runs in the Preview transaction, with the handler's view of the session.
                var self = (IClientSessionHandle)(object)this;
                var cancellation = arguments.OfType<CancellationToken>().FirstOrDefault();
                try
                {
                    return ((Delegate)arguments[0]!).DynamicInvoke(self, cancellation);
                }
                catch (TargetInvocationException inner) when (inner.InnerException is not null)
                {
                    System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(inner.InnerException).Throw();
                    throw;
                }
        }

        try
        {
            return method.Invoke(_state.Session, arguments);
        }
        catch (TargetInvocationException inner) when (inner.InnerException is not null)
        {
            System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(inner.InnerException).Throw();
            throw;
        }
    }
}
