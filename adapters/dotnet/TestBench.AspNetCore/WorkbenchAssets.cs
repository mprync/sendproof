using Microsoft.AspNetCore.Http;

namespace TestBench.AspNetCore;

internal static class WorkbenchAssets
{
    private const string ResourcePrefix = "TestBench.Ui/";

    private static readonly IReadOnlyDictionary<string, string> Assets = typeof(WorkbenchAssets).Assembly
        .GetManifestResourceNames()
        .Where(name => name.StartsWith(ResourcePrefix, StringComparison.Ordinal))
        .ToDictionary(name => name[ResourcePrefix.Length..].Replace('\\', '/'), StringComparer.Ordinal);

    internal static IResult Serve(HttpContext context, string asset)
    {
        if (!Assets.TryGetValue(asset, out var resource) || GetContentType(asset) is not { } contentType ||
            typeof(WorkbenchAssets).Assembly.GetManifestResourceStream(resource) is not { } stream)
        {
            return Results.NotFound();
        }

        context.Response.Headers.CacheControl = "no-cache";
        context.Response.Headers.XContentTypeOptions = "nosniff";
        return Results.Stream(stream, contentType);
    }

    private static string? GetContentType(string asset) => Path.GetExtension(asset) switch
    {
        ".html" => "text/html; charset=utf-8",
        ".css" => "text/css; charset=utf-8",
        ".js" or ".mjs" => "text/javascript; charset=utf-8",
        ".json" => "application/json; charset=utf-8",
        ".svg" => "image/svg+xml",
        ".png" => "image/png",
        ".webp" => "image/webp",
        ".ico" => "image/x-icon",
        ".woff2" => "font/woff2",
        _ => null
    };
}
