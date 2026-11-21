using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Net.Http.Headers;

namespace TestBench.AspNetCore;

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
        var recorder = context.RequestServices.GetRequiredService<TestBenchPreview>();
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
        Exception? failure = null;

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

            if (preview.Session is { } session)
            {
                try
                {
                    await session.RollbackAsync(CancellationToken.None);
                    if (failure is null && preview.EndpointCompleted && !capture.ExceededLimit)
                    {
                        var snapshot = recorder.Finish();
                        envelope = CreateEnvelope(capture, session, snapshot);
                    }
                }
                catch (Exception error)
                {
                    failure = Combine(failure, error);
                }
                finally
                {
                    if (recorder.IsActive)
                    {
                        recorder.Finish();
                    }

                    try
                    {
                        await session.DisposeAsync();
                    }
                    catch (Exception error)
                    {
                        failure = Combine(failure, error);
                    }
                }
            }
        }
        finally
        {
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
        }

        if (context.RequestAborted.IsCancellationRequested)
        {
            return;
        }

        if (failure is not null)
        {
            logger.LogError(failure, "A Test Bench preview failed for {Method} {Path}.", context.Request.Method, originalPath);
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

    private static PreviewEnvelope CreateEnvelope(PreviewResponseCapture response, IPreviewSession session, CaptureSnapshot capture)
    {
        var (changes, truncated) = CaptureLimits.SnapshotChanges(session.Changes);
        var headers = response.Headers.Where(header => !PrivateHeaders.Contains(header.Key) && header.Key.Length <= CaptureLimits.Name)
            .Take(CaptureLimits.Parameters).ToDictionary(header => header.Key.ToLowerInvariant(),
                header => CaptureLimits.Clip(header.Value.ToString()), StringComparer.Ordinal);
        return new PreviewEnvelope(response.StatusCode, headers, response.ReadBody(), changes, capture.Effects, capture.Logs, true,
            truncated || session.ChangesTruncated, capture.EffectsTruncated, capture.LogsTruncated);
    }

    private sealed record PreviewEnvelope(int Status, Dictionary<string, string> Headers, object? Body,
        PreviewChange[] Changes, PreviewEffect[] Effects, PreviewLog[] Logs, bool RolledBack,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] bool ChangesTruncated,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] bool EffectsTruncated,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] bool LogsTruncated);
}
