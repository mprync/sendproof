using System.Diagnostics;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Sendproof.AspNetCore;

internal sealed class PreviewStartupFilter(SendproofOptions options, IWebHostEnvironment environment, ILogger<PreviewTransport> logger, CaptureContext capture) : IStartupFilter
{
    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
    {
        app.Use((context, continuation) => InvokeAsync(context, continuation));
        next(app);
    };

    private async Task InvokeAsync(HttpContext context, RequestDelegate next)
    {
        using var scope = capture.Enter();
        await DispatchAsync(context, next);
    }

    private Task DispatchAsync(HttpContext context, RequestDelegate next)
    {
        var started = Stopwatch.GetTimestamp();
        var request = context.Request;
        var path = request.Path.Value ?? "";
        var prefix = path.IndexOf(PreviewProtocol.Prefix, StringComparison.OrdinalIgnoreCase);
        var isReserved = prefix >= 0 && (prefix + PreviewProtocol.Prefix.Length == path.Length ||
            path[prefix + PreviewProtocol.Prefix.Length] == '/');
        if (!isReserved)
        {
            if (options.Enabled(environment) && !HttpMethods.IsHead(request.Method) &&
                ObservedSend.Requested(request) && PreviewProtocol.IsSameOrigin(request))
            {
                context.Features.Set(new ObservedRequest(started));
            }

            return PreviewProtocol.RequestsRollback(request)
                ? PreviewProtocol.RejectAsync(context, StatusCodes.Status400BadRequest, "Use the Sendproof preview URL for rollback requests.")
                : next(context);
        }

        if (!options.Enabled(environment))
        {
            return PreviewProtocol.RejectAsync(context, StatusCodes.Status404NotFound, "Sendproof previews are unavailable.");
        }

        if (!PreviewProtocol.HasExactPreference(request))
        {
            return PreviewProtocol.RejectAsync(context, StatusCodes.Status400BadRequest, "A Sendproof preview requires Prefer: tx=rollback.");
        }

        if (HttpMethods.IsHead(request.Method))
        {
            return PreviewProtocol.RejectAsync(context, StatusCodes.Status405MethodNotAllowed, "A preview requires a response body.");
        }

        var target = path[(prefix + PreviewProtocol.Prefix.Length)..];
        if (target.Length == 0 || target.StartsWith("//", StringComparison.Ordinal) ||
            new PathString(target).StartsWithSegments("/sendproof") || !IsValidTarget(target))
        {
            return PreviewProtocol.RejectAsync(context, StatusCodes.Status400BadRequest, "The Sendproof preview target is invalid.");
        }

        var preview = new PreviewRequest(request.PathBase.Add(request.Path), new PathString(target), started);
        return PreviewTransport.ExecuteAsync(context, next, preview, new PathString(path[..prefix] + target), logger, capture);
    }

    private static bool IsValidTarget(string target)
    {
        var decoded = Uri.UnescapeDataString(target);
        return !decoded.StartsWith("//", StringComparison.Ordinal) && !decoded.Contains('\\') &&
            !decoded.Any(char.IsControl) && !decoded.Split('/').Any(segment => segment is "." or "..");
    }
}
