using System.Text.Json;
using Microsoft.AspNetCore.Http;

namespace Sendproof.AspNetCore;

internal static class PreviewProtocol
{
    internal const string Prefix = "/sendproof/_preview";
    internal const string RollbackPreference = "tx=rollback";
    internal static JsonSerializerOptions JsonOptions { get; } = new(JsonSerializerDefaults.Web);

    internal static bool RequestsRollback(HttpRequest request) => request.Headers["Prefer"].Any(value =>
        value?.Split(',', ';').Any(part =>
        {
            var assignment = part.Split('=', 2, StringSplitOptions.TrimEntries);
            return assignment.Length == 2 && assignment[0].Equals("tx", StringComparison.OrdinalIgnoreCase) &&
                assignment[1].Trim('"').Equals("rollback", StringComparison.OrdinalIgnoreCase);
        }) == true);

    internal static bool HasExactPreference(HttpRequest request)
    {
        var values = request.Headers["Prefer"];
        return values.Count == 1 && string.Equals(values[0]?.Trim(), RollbackPreference, StringComparison.OrdinalIgnoreCase);
    }

    internal static bool IsSameOrigin(HttpRequest request)
    {
        if (string.Equals(request.Headers["Sec-Fetch-Site"], "cross-site", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var origins = request.Headers.Origin;
        return origins.Count == 0 || origins.Count == 1 &&
            Uri.TryCreate(origins[0], UriKind.Absolute, out var origin) &&
            Uri.TryCreate($"{request.Scheme}://{request.Host.ToUriComponent()}", UriKind.Absolute, out var expected) &&
            origin.Scheme == expected.Scheme && origin.IdnHost == expected.IdnHost && origin.Port == expected.Port &&
            origin.UserInfo.Length == 0 && origin.AbsolutePath == "/" && origin.Query.Length == 0 && origin.Fragment.Length == 0;
    }

    internal static Task RejectAsync(HttpContext context, int statusCode, string title)
    {
        context.Response.Headers.CacheControl = "no-store";
        return Results.Problem(statusCode: statusCode, title: title).ExecuteAsync(context);
    }

    /// <summary>
    /// The blocked-Preview response (spec/data-stores.md): 409, <c>application/problem+json</c>, no-store, and never
    /// <c>Preference-Applied</c>, so no client can mistake it for a confirmed rollback. It names the store and the
    /// refused command, never its arguments, and carries nothing of the handler's own response.
    /// </summary>
    internal static Task RejectBlockedAsync(HttpContext context, BlockedWrite blocked)
    {
        context.Response.Headers.CacheControl = "no-store";
        return Results.Problem(type: "about:blank", title: "Preview unavailable", statusCode: StatusCodes.Status409Conflict,
            detail: blocked.Detail, extensions: new Dictionary<string, object?>
            {
                ["code"] = "preview_unavailable",
                ["store"] = blocked.Store,
                ["operation"] = blocked.Operation,
                ["rolledBack"] = false
            }).ExecuteAsync(context);
    }
}

internal sealed class PreviewRequest(PathString originalPath, PathString targetPath, long started)
{
    internal IPreviewSession? Session { get; set; }

    /// <summary>The data stores that began this Preview, finished after the handler whether or not it succeeded.</summary>
    internal IReadOnlyList<IPreviewDataStore> Stores { get; set; } = [];
    internal long Started { get; } = started;
    internal CaptureClock Clock { get; } = new(started);
    internal bool HasInvokedEndpoint { get; set; }
    internal bool EndpointCompleted { get; set; }

    internal bool MatchesTarget(HttpRequest request) => request.Path == targetPath &&
        request.PathBase.Add(new PathString(PreviewProtocol.Prefix)).Add(request.Path) == originalPath;
}
