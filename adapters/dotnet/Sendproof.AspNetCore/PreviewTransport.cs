using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Net.Http.Headers;

namespace Sendproof.AspNetCore;

internal sealed class PreviewTransport
{
    // Session, redirect and framing headers, plus every RFC 9110 hop-by-hop header, describe the simulated
    // transport rather than the operation's result. None of them belongs in the preview envelope.
    private static readonly HashSet<string> PrivateHeaders = new(StringComparer.OrdinalIgnoreCase)
    {
        HeaderNames.SetCookie, HeaderNames.Location, HeaderNames.ContentLength, HeaderNames.TransferEncoding,
        HeaderNames.Connection, HeaderNames.Upgrade, HeaderNames.Trailer, HeaderNames.KeepAlive, HeaderNames.TE,
        HeaderNames.ProxyAuthenticate, "Proxy-Connection"
    };

    internal static async Task ExecuteAsync(HttpContext context, RequestDelegate next, PreviewRequest preview,
        PathString rewrittenPath, ILogger<PreviewTransport> logger, CaptureContext captureContext)
    {
        // RequestServices registers its disposal against the current response's OnCompleted.
        // Attach it to the real response so the provider and its DbContext survive rollback.
        var recorder = context.RequestServices.GetRequiredService<SendproofPreview>();
        // From here every store hook refuses writes, including ones a handler sends late, after its response settled.
        recorder.MarkPreview();
        captureContext.Open(recorder);
        using var scope = captureContext.Enter(recorder);
        var features = context.Features;
        var originalResponse = features.Get<IHttpResponseFeature>()!;
        var originalBody = features.Get<IHttpResponseBodyFeature>()!;
        var originalUpgrade = features.Get<IHttpUpgradeFeature>();
        var originalWebSocket = features.Get<IHttpWebSocketFeature>();
        var originalConnect = features.Get<IHttpExtendedConnectFeature>();
        var originalTrailers = features.Get<IHttpResponseTrailersFeature>();
        var originalPath = context.Request.Path;
        var requestHeaders = context.Request.Headers;
        var originalEncoding = requestHeaders.AcceptEncoding;
        var originalCacheControl = requestHeaders.CacheControl;
        var originalEndpoint = context.GetEndpoint();
        var originalRouteValues = context.Request.RouteValues;
        var capture = new PreviewResponseCapture();
        capture.Headers.CacheControl = "no-store";
        PreviewEnvelope? envelope = null;
        // The handler's own failure. A blocked write still answers 409 when the handler threw after it.
        Exception? failure = null;
        // A store or rollback failure: the Preview is never confirmed and never reported as blocked.
        Exception? unsafeFailure = null;
        // What happened to the held transactions of a Preview inside a session.
        var step = StepOutcome.None;

        try
        {
            context.Request.Path = rewrittenPath;
            requestHeaders.Remove(HeaderNames.AcceptEncoding);
            requestHeaders.CacheControl = "no-cache, no-store";
            features.Set(preview);
            features.Set<IHttpResponseFeature>(capture);
            features.Set<IHttpResponseBodyFeature>(capture);
            features.Set<IHttpUpgradeFeature>(null);
            features.Set<IHttpWebSocketFeature>(null);
            features.Set<IHttpExtendedConnectFeature>(null);
            features.Set<IHttpResponseTrailersFeature>(null);

            try
            {
                await next(context);
                await capture.FinishAsync();
            }
            catch (Exception error)
            {
                failure = error;
            }

            try
            {
                await capture.RunCompletionCallbacksAsync();
            }
            catch (Exception error)
            {
                failure = Combine(failure, error);
            }

            // Pipeline order (spec/data-stores.md): the stores capture their changes and abort their transactions, then
            // SQL rolls back. A failed abort or rollback, or a recorded fault, answers 500; otherwise a blocked write
            // answers 409; otherwise the Preview is confirmed.
            foreach (var store in preview.Stores)
            {
                try
                {
                    await store.FinishPreviewAsync(recorder, CancellationToken.None);
                }
                catch (Exception error)
                {
                    unsafeFailure = Combine(unsafeFailure, error);
                }
            }

            var session = preview.Session;
            if (session is not null)
            {
                try
                {
                    await session.RollbackAsync(CancellationToken.None);
                }
                catch (Exception error)
                {
                    unsafeFailure = Combine(unsafeFailure, error);
                }
            }

            var succeeded = failure is null && unsafeFailure is null && recorder.Fault is null && recorder.Blocked is null &&
                preview.EndpointCompleted && !capture.ExceededLimit;
            if (preview.HeldSession is { } held && (preview.StepBegun || preview.StepBroken is not null))
            {
                (step, unsafeFailure) = await FinishStepAsync(context.RequestServices.GetRequiredService<PreviewSessionStore>(), held, preview,
                    recorder, succeeded, unsafeFailure);
                succeeded &= step == StepOutcome.Kept;
            }

            try
            {
                if (succeeded)
                {
                    var snapshot = recorder.Finish();
                    envelope = CreateEnvelope(capture, session, preview.HeldSession, preview.Step, snapshot);
                }
            }
            catch (Exception error)
            {
                unsafeFailure = Combine(unsafeFailure, error);
            }
            finally
            {
                if (recorder.IsActive)
                {
                    recorder.Finish();
                }

                if (session is not null)
                {
                    try
                    {
                        await session.DisposeAsync();
                    }
                    catch (Exception error)
                    {
                        unsafeFailure = Combine(unsafeFailure, error);
                    }
                }
            }
        }
        finally
        {
            captureContext.Close(recorder);
            preview.Clock.EndHandler();
            features.Set<PreviewRequest>(null);
            features.Set(originalResponse);
            features.Set(originalBody);
            features.Set(originalUpgrade);
            features.Set(originalWebSocket);
            features.Set(originalConnect);
            features.Set(originalTrailers);
            context.Request.Path = originalPath;
            requestHeaders.AcceptEncoding = originalEncoding;
            requestHeaders.CacheControl = originalCacheControl;
            context.SetEndpoint(originalEndpoint);
            context.Request.RouteValues = originalRouteValues;
            await capture.Stream.DisposeAsync();
            if (preview.HeldSession is { } held)
            {
                await context.RequestServices.GetRequiredService<PreviewSessionStore>().ExitAsync(held);
            }
        }

        if (context.RequestAborted.IsCancellationRequested)
        {
            return;
        }

        if (preview.SessionRefused is { } refusal)
        {
            await PreviewProtocol.RejectSessionAsync(context, refusal);
            return;
        }

        if (step == StepOutcome.Failed)
        {
            await PreviewProtocol.RejectSessionAsync(context, SessionRefusal.Failed, CaptureLimits.Clip(preview.HeldSession!.EndedReason ??
                preview.StepBroken?.Message ?? "A store ended the session's transaction."));
            return;
        }

        if (step == StepOutcome.StepUndone)
        {
            await PreviewProtocol.RejectAsync(context, StatusCodes.Status500InternalServerError,
                "The step left the session's transaction unusable, so it was undone. Run it again or rewind.");
            return;
        }

        if (unsafeFailure is not null || recorder.Fault is not null)
        {
            logger.LogError(unsafeFailure ?? recorder.Fault, "A Sendproof preview could not be completed safely for {Method} {Path}.",
                context.Request.Method, originalPath);
            await PreviewProtocol.RejectAsync(context, StatusCodes.Status500InternalServerError, "The preview could not be completed safely.");
            return;
        }

        if (recorder.Blocked is { } blocked)
        {
            await PreviewProtocol.RejectBlockedAsync(context, blocked);
            return;
        }

        if (failure is not null)
        {
            logger.LogError(failure, "A Sendproof preview failed for {Method} {Path}.", context.Request.Method, originalPath);
            var limitError = failure is PreviewResponseTooLargeException;
            await PreviewProtocol.RejectAsync(context,
                limitError ? StatusCodes.Status413PayloadTooLarge : StatusCodes.Status500InternalServerError,
                limitError ? "The preview response exceeds the 1 MiB limit." : "The preview could not be completed safely.");
            return;
        }

        if (capture.ExceededLimit)
        {
            await PreviewProtocol.RejectAsync(context, StatusCodes.Status413PayloadTooLarge, "The preview response exceeds the 1 MiB limit.");
            return;
        }

        if (envelope is null)
        {
            await RejectUnexecutedAsync(context, capture, preview.HasInvokedEndpoint);
            return;
        }

        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers["Preference-Applied"] = PreviewProtocol.RollbackPreference;
        var serializeStarted = Stopwatch.GetTimestamp();
        var json = JsonSerializer.SerializeToUtf8Bytes(envelope, PreviewProtocol.JsonOptions);
        recorder.Timing(preview.Clock, Stopwatch.GetElapsedTime(serializeStarted).TotalMilliseconds).AppendHeader(context.Response);
        context.Response.ContentType = "application/json; charset=utf-8";
        await context.Response.Body.WriteAsync(json, context.RequestAborted);
    }

    private static Exception Combine(Exception? previous, Exception error) => previous is null ? error : new AggregateException(previous, error);

    private static Task RejectUnexecutedAsync(HttpContext context, PreviewResponseCapture capture, bool invoked)
    {
        if (invoked)
        {
            return PreviewProtocol.RejectAsync(context, StatusCodes.Status500InternalServerError, "The preview operation did not finish.");
        }

        var status = capture.StatusCode;
        if (capture.Headers.TryGetValue(HeaderNames.WWWAuthenticate, out var challenge))
        {
            context.Response.Headers.WWWAuthenticate = challenge;
        }

        var title = status switch
        {
            StatusCodes.Status401Unauthorized => "Authentication is required for this preview.",
            StatusCodes.Status403Forbidden => "This preview is forbidden.",
            StatusCodes.Status404NotFound or StatusCodes.Status405MethodNotAllowed => "The preview target was not found for this method.",
            StatusCodes.Status503ServiceUnavailable => "Preview requires one available preview provider.",
            >= 300 and < 400 => "Preview redirects are disabled. Sign in through the workbench first.",
            >= 400 and < 500 when status != StatusCodes.Status409Conflict => "The host rejected the preview request.",
            _ => "This operation is unavailable for preview."
        };
        if (status < 400 || status >= 500 && status != StatusCodes.Status503ServiceUnavailable)
        {
            status = status >= 300 && status < 400 ? StatusCodes.Status401Unauthorized : StatusCodes.Status409Conflict;
        }

        return PreviewProtocol.RejectAsync(context, status, title);
    }

    /// <summary>
    /// After a step's handler: keeps the step in every held transaction when it succeeded, or rolls each back to the step's
    /// savepoint when it didn't, so a blocked write or a failed handler leaves the session usable. A store that ended its
    /// transaction, a fault, or a held transaction that can't be vouched for closes the session and rolls everything back.
    /// </summary>
    private static async Task<(StepOutcome Outcome, Exception? UnsafeFailure)> FinishStepAsync(PreviewSessionStore sessions, PreviewSession held, PreviewRequest preview,
        SendproofPreview recorder, bool succeeded, Exception? unsafeFailure)
    {
        var outcome = preview.StepBroken switch
        {
            PreviewSessionFailedException => StepOutcome.Failed,
            { } broken => Fail(broken),
            _ when held.EndedReason is not null => StepOutcome.Failed,
            _ when unsafeFailure is not null || recorder.Fault is not null => StepOutcome.Broken,
            _ => StepOutcome.None
        };

        if (outcome == StepOutcome.None)
        {
            outcome = succeeded ? await KeepAsync() : await UndoAsync(StepOutcome.Undone);
        }

        if (outcome is StepOutcome.Failed or StepOutcome.Broken)
        {
            try
            {
                await sessions.CloseAsync(held);
            }
            catch (Exception error)
            {
                unsafeFailure = Combine(unsafeFailure, error);
            }
        }
        else if (outcome == StepOutcome.Kept)
        {
            held.NextStep = preview.Step + 1;
        }

        return (outcome, unsafeFailure);

        StepOutcome Fail(Exception error)
        {
            unsafeFailure = Combine(unsafeFailure, error);
            return StepOutcome.Broken;
        }

        async Task<StepOutcome> KeepAsync()
        {
            foreach (var part in held.Parts)
            {
                try
                {
                    await part.KeepStepAsync(CancellationToken.None);
                }
                catch (PreviewStepUndoneException)
                {
                    // That store rolled the step back on its own; the others follow so the session stays consistent.
                    return await UndoAsync(StepOutcome.StepUndone);
                }
                catch (PreviewSessionFailedException)
                {
                    return StepOutcome.Failed;
                }
                catch (Exception error)
                {
                    return Fail(error);
                }
            }

            return StepOutcome.Kept;
        }

        async Task<StepOutcome> UndoAsync(StepOutcome undone)
        {
            foreach (var part in held.Parts)
            {
                try
                {
                    await part.UndoStepAsync(CancellationToken.None);
                }
                catch (PreviewSessionFailedException)
                {
                    return StepOutcome.Failed;
                }
                catch (Exception error)
                {
                    return Fail(error);
                }
            }

            return held.EndedReason is null ? undone : StepOutcome.Failed;
        }
    }

    /// <summary>What happened to a session step's held transactions.</summary>
    private enum StepOutcome
    {
        /// <summary>Not a session step.</summary>
        None,

        /// <summary>The step's writes stay in the held transactions.</summary>
        Kept,

        /// <summary>The step was rolled back to its savepoint (a blocked write, a failed handler); the session is usable.</summary>
        Undone,

        /// <summary>The step succeeded but couldn't be kept, so it was rolled back; the session is usable.</summary>
        StepUndone,

        /// <summary>A store ended the session's transaction: closed, 409 <c>session_failed</c>.</summary>
        Failed,

        /// <summary>A held transaction can't be vouched for: closed, 500 without confirmation.</summary>
        Broken
    }

    private static PreviewEnvelope CreateEnvelope(PreviewResponseCapture response, IPreviewSession? session, PreviewSession? held,
        int step, CaptureSnapshot capture)
    {
        var (changes, truncated) = CaptureLimits.SnapshotChanges(
            [.. session?.Changes ?? [], .. held?.Parts.SelectMany(part => part.Changes) ?? [], .. capture.Changes ?? []]);
        var headers = response.Headers.Where(header => !PrivateHeaders.Contains(header.Key) && header.Key.Length <= CaptureLimits.Name)
            .Take(CaptureLimits.Parameters).ToDictionary(header => header.Key.ToLowerInvariant(),
                header => CaptureLimits.Clip(header.Value.ToString()), StringComparer.Ordinal);
        return new PreviewEnvelope(response.StatusCode, headers, response.ReadBody(), changes, capture.Effects, capture.Logs, true,
            truncated || session?.ChangesTruncated == true || held?.Parts.Any(part => part.ChangesTruncated) == true || capture.ChangesTruncated,
            capture.EffectsTruncated, capture.LogsTruncated, held is null ? null : new SessionStep(held.Id, step));
    }

    private sealed record PreviewEnvelope(int Status, Dictionary<string, string> Headers, object? Body,
        PreviewChange[] Changes, PreviewEffect[] Effects, PreviewLog[] Logs, bool RolledBack,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] bool ChangesTruncated,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] bool EffectsTruncated,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] bool LogsTruncated,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] SessionStep? Session);

    /// <summary>The envelope's <c>session</c>: which session the step ran in, and its number from 1.</summary>
    private sealed record SessionStep(string Id, int Step);
}
