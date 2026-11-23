using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Sendproof.AspNetCore;

/// <summary>
/// <c>POST {mount}/_api/sessions</c>, <c>POST …/sessions/{id}/rewind</c> and <c>DELETE …/sessions/{id}</c>
/// (spec/README.md "Preview sessions"). Admission matches Preview: the workbench policy (on the route group), Sendproof
/// enabled (the routes exist only then), and the same-origin rules.
/// </summary>
internal static class PreviewSessionEndpoints
{
    /// <summary>
    /// Why this host can't hold preview sessions, or <see langword="null"/> when it can: every hooked store that can roll
    /// back must be able to hold its transaction across requests.
    /// </summary>
    internal static string? Unavailable(HttpContext context)
    {
        var provider = PreviewEndpointPolicy.GetProvider(context);
        var stores = PreviewEndpointPolicy.GetDataStores(context);
        if (provider is null && stores.Count == 0)
        {
            return "Preview requires one available preview provider.";
        }

        if (PreviewEndpointPolicy.Blocked(stores) is { } blocked)
        {
            return blocked.Reason;
        }

        return provider switch
        {
            null => null,
            IPreviewSessionSource source => source.SessionUnavailableReason,
            _ => "This host's preview provider can't hold a transaction across requests."
        };
    }

    internal static async Task<IResult> OpenAsync(HttpContext context, PreviewSessionStore sessions, ILogger<PreviewSessionStore> logger)
    {
        context.Response.Headers.CacheControl = "no-store";
        if (!PreviewProtocol.IsSameOrigin(context.Request))
        {
            return Results.Problem(statusCode: StatusCodes.Status403Forbidden, title: "Preview sessions must be opened from the same origin.");
        }

        if (SessionOwner.From(context) is not { } owner)
        {
            return Results.Problem(statusCode: StatusCodes.Status403Forbidden,
                title: "A preview session needs one stable subject (NameIdentifier or sub) for the signed-in caller.");
        }

        var parts = new List<IHeldPreview>();
        try
        {
            if (Unavailable(context) is { } reason)
            {
                return Results.Problem(statusCode: StatusCodes.Status409Conflict, title: "Preview sessions are unavailable.",
                    detail: CaptureLimits.Clip(reason));
            }

            // The SQL provider first, then the data stores in registration order, as a single Preview begins them.
            var sources = new List<IPreviewSessionSource>();
            if (PreviewEndpointPolicy.GetProvider(context) is IPreviewSessionSource provider)
            {
                sources.Add(provider);
            }

            sources.AddRange(PreviewEndpointPolicy.GetDataStores(context).OfType<IPreviewSessionSource>());
            foreach (var source in sources)
            {
                if (await source.HoldAsync(context, context.RequestAborted) is { } part)
                {
                    parts.Add(part);
                }
            }
        }
        catch (PreviewStoreBusyException busy)
        {
            await EndAllAsync(parts, logger);
            logger.LogWarning("A Sendproof preview session could not be opened: {Reason}", busy.Message);
            var idle = (int)sessions.IdleTimeout.TotalSeconds;
            return PreviewProtocol.SessionProblem(SessionRefusal.StoreBusy(busy.Store),
                $"That session ends by itself after its idle timeout ({idle} seconds), or when it is ended.", idle);
        }
        catch (Exception error)
        {
            await EndAllAsync(parts, logger);
            logger.LogError(error, "A Sendproof preview session could not be opened.");
            return PreviewProtocol.SessionProblem(SessionRefusal.Failed);
        }

        if (sessions.Add(owner, parts) is not { } session)
        {
            await EndAllAsync(parts, logger);
            return Results.Problem(statusCode: StatusCodes.Status429TooManyRequests, title: "Too many preview sessions are open. End one first.",
                extensions: new Dictionary<string, object?> { ["code"] = "session_limit" });
        }

        return Results.Json(new
        {
            id = session.Id,
            idleTimeoutSeconds = (int)sessions.IdleTimeout.TotalSeconds,
            maxLifetimeSeconds = (int)sessions.MaxLifetime.TotalSeconds
        }, PreviewProtocol.JsonOptions, statusCode: StatusCodes.Status201Created);
    }

    internal static async Task<IResult> RewindAsync(HttpContext context, string id, PreviewSessionStore sessions, ILogger<PreviewSessionStore> logger)
    {
        context.Response.Headers.CacheControl = "no-store";
        int step;
        try
        {
            var input = await JsonSerializer.DeserializeAsync<RewindInput>(context.Request.Body, PreviewProtocol.JsonOptions, context.RequestAborted);
            step = input?.Step ?? 0;
        }
        catch (JsonException)
        {
            step = 0;
        }

        if (Enter(context, id, sessions, out var session) is { } refused)
        {
            return refused;
        }

        try
        {
            if (step < 1 || step > session.NextStep)
            {
                return Results.Problem(statusCode: StatusCodes.Status400BadRequest,
                    title: $"Rewind to a step from 1 to {session.NextStep}, the next step this session runs.");
            }

            if (step < session.NextStep)
            {
                // Data stores first, then SQL, as a Preview's pipeline ends them.
                foreach (var part in session.Parts.Reverse())
                {
                    await part.RewindAsync(step, context.RequestAborted);
                }

                session.NextStep = step;
            }

            return Results.NoContent();
        }
        catch (Exception error)
        {
            // Some stores may have rewound and others not: the session can't go on.
            var failed = error is PreviewSessionFailedException || session.EndedReason is not null;
            await CloseQuietlyAsync(sessions, session);
            if (failed)
            {
                return PreviewProtocol.SessionProblem(SessionRefusal.Failed, CaptureLimits.Clip(session.EndedReason ?? error.Message));
            }

            logger.LogError(error, "A Sendproof preview session could not be rewound.");
            return Results.Problem(statusCode: StatusCodes.Status500InternalServerError,
                title: "The preview session could not be rewound, so it was closed and rolled back.");
        }
        finally
        {
            await sessions.ExitAsync(session);
        }
    }

    internal static async Task<IResult> EndAsync(HttpContext context, string id, PreviewSessionStore sessions)
    {
        context.Response.Headers.CacheControl = "no-store";
        if (Enter(context, id, sessions, out var session) is { } refused)
        {
            return refused;
        }

        try
        {
            await sessions.CloseAsync(session);
            return Results.NoContent();
        }
        catch (Exception)
        {
            // Logged by the store. The session is gone either way.
            return Results.Problem(statusCode: StatusCodes.Status500InternalServerError, title: "The preview session could not be rolled back cleanly.");
        }
        finally
        {
            await sessions.ExitAsync(session);
        }
    }

    private static IResult? Enter(HttpContext context, string id, PreviewSessionStore sessions, out PreviewSession session)
    {
        // A cross-origin caller learns nothing about which sessions exist.
        var refusal = PreviewProtocol.IsSameOrigin(context.Request)
            ? sessions.TryEnter(id, SessionOwner.From(context), out session)
            : Refuse(out session);
        return refusal is null ? null : PreviewProtocol.SessionProblem(refusal);

        static SessionRefusal Refuse(out PreviewSession none)
        {
            none = null!;
            return SessionRefusal.NotFound;
        }
    }

    private static async Task CloseQuietlyAsync(PreviewSessionStore sessions, PreviewSession session)
    {
        try
        {
            await sessions.CloseAsync(session);
        }
        catch (Exception)
        {
            // Logged by the store.
        }
    }

    private static async Task EndAllAsync(IEnumerable<IHeldPreview> parts, ILogger logger)
    {
        foreach (var part in parts.Reverse())
        {
            try
            {
                await part.EndAsync();
            }
            catch (Exception error)
            {
                logger.LogError(error, "A held preview transaction could not be rolled back.");
            }
        }
    }

    private sealed record RewindInput(int? Step);
}
