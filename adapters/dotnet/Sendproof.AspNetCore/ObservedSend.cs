using System.Diagnostics;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Policy;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Sendproof.AspNetCore;

internal sealed class ObservedRequest(long started)
{
    internal long Started { get; } = started;
    internal bool Invoked { get; set; }
}

internal static class ObservedSend
{
    internal const string TraceHeader = "X-Sendproof-Trace";

    internal static bool Requested(HttpRequest request) => request.Headers.GetCommaSeparatedValues("Prefer").Any(value =>
        value.Split(';', 2)[0].Trim().Equals("trace", StringComparison.OrdinalIgnoreCase));

    internal static async Task ExecuteAsync(HttpContext context, RequestDelegate execute, SendproofOptions options)
    {
        var request = context.Features.Get<ObservedRequest>()!;
        if (request.Invoked || context.Response.HasStarted || TraceOwner.From(context) is not { } owner)
        {
            await execute(context);
            return;
        }

        request.Invoked = true;
        var services = context.RequestServices;
        var logger = services.GetRequiredService<ILogger<ObservedRequest>>();
        IPreviewObservation? observation = null;
        var observing = false;
        try
        {
            if (await IsWorkbenchAuthorizedAsync(context, options, owner))
            {
                var provider = PreviewEndpointPolicy.GetProvider(context);
                observation = provider?.BeginObservation(context);
                // A host with only data stores (no SQL provider) is observed too: its Db entries still trace.
                observing = provider is not null || PreviewEndpointPolicy.GetDataStores(context).Count > 0;
            }
        }
        catch (Exception error) when (error is not OutOfMemoryException)
        {
            observing = false;
            logger.LogWarning(error, "Sendproof could not start observing the send.");
        }

        if (!observing)
        {
            await execute(context);
            return;
        }

        var recorder = services.GetRequiredService<SendproofPreview>();
        var store = services.GetRequiredService<ObservedTraceStore>();
        var clock = new CaptureClock(request.Started);
        var reservation = store.Reserve(owner);
        var valid = true;
        CaptureTiming? finishedTiming = null;
        context.Response.OnStarting(() =>
        {
            if (valid)
            {
                context.Response.Headers[TraceHeader] = reservation.Id.ToString("N");
                context.Response.Headers.CacheControl = "no-store";
                (finishedTiming ?? recorder.Timing(clock)).AppendHeader(context.Response);
            }

            return Task.CompletedTask;
        });

        clock.StartHandler();
        recorder.Begin(rollback: false, request.Started);
        var completed = false;
        try
        {
            using var scope = services.GetRequiredService<CaptureContext>().Enter(recorder);
            await execute(context);
            completed = !context.RequestAborted.IsCancellationRequested && TraceOwner.From(context) == owner;
        }
        finally
        {
            clock.EndHandler();
            var capture = recorder.Finish();
            try
            {
                if (completed)
                {
                    var serializeStarted = Stopwatch.GetTimestamp();
                    var (changes, truncated) = CaptureLimits.SnapshotChanges([.. observation?.Changes ?? [], .. capture.Changes ?? []]);
                    finishedTiming = recorder.Timing(clock, Stopwatch.GetElapsedTime(serializeStarted).TotalMilliseconds);
                    reservation.Result.TrySetResult(new ObservedTrace(changes, capture.Effects, capture.Logs, finishedTiming,
                        truncated || observation?.ChangesTruncated == true || capture.ChangesTruncated, capture.EffectsTruncated, capture.LogsTruncated));
                }
            }
            catch (Exception error) when (error is not OutOfMemoryException)
            {
                completed = false;
                logger.LogWarning(error, "Sendproof could not collect the observed send.");
            }
            finally
            {
                if (!completed)
                {
                    valid = false;
                    store.Discard(reservation);
                }

                try
                {
                    observation?.Dispose();
                }
                catch (Exception error) when (error is not OutOfMemoryException)
                {
                    logger.LogWarning(error, "Sendproof could not release the send observation.");
                }
            }
        }
    }

    private static async Task<bool> IsWorkbenchAuthorizedAsync(HttpContext context, SendproofOptions options, TraceOwner owner)
    {
        if (options.AuthorizationPolicy is not { } name)
        {
            return true;
        }

        var services = context.RequestServices;
        var policy = await services.GetRequiredService<IAuthorizationPolicyProvider>().GetPolicyAsync(name);
        if (policy is null)
        {
            return false;
        }

        var evaluator = services.GetRequiredService<IPolicyEvaluator>();
        var originalUser = context.User;
        try
        {
            var authentication = await evaluator.AuthenticateAsync(policy, context);
            return TraceOwner.From(context) == owner &&
                (await evaluator.AuthorizeAsync(policy, authentication, context, context)).Succeeded;
        }
        finally
        {
            context.User = originalUser;
        }
    }
}
