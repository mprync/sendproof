using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Hosting;

namespace Sendproof.AspNetCore;

internal sealed class SendproofOptions
{
    internal string OpenApiUrl { get; set; } = "/openapi/v1.json";
    internal string? ApiName { get; set; }
    internal HashSet<string> Environments { get; set; } = new(StringComparer.OrdinalIgnoreCase) { Microsoft.Extensions.Hosting.Environments.Development };
    internal bool DiscoverAuthSchemes { get; set; } = true;
    internal List<AuthProvider> AuthProviders { get; } = [];
    internal List<OpenApiDocument> Documents { get; } = [];
    internal List<string> FieldModules { get; } = [];
    internal string? AuthorizationPolicy { get; set; }
    internal bool? IncludeSqlParameterValues { get; set; }
    internal bool CaptureEfCommands { get; set; }
    internal bool IsMapped { get; set; }

    internal bool Enabled(IHostEnvironment environment) => IsMapped && Environments.Contains(environment.EnvironmentName);
}

internal sealed record AuthProvider(string Label, string Kind, string? Url);
internal sealed record OpenApiDocument(string Name, string Url);

internal static class LocalUrl
{
    internal static string Validate(string url)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(url);
        return IsLocal(url) ? url : throw new ArgumentException("Use an application-relative, same-origin path.", nameof(url));
    }

    internal static bool IsLocal(string url)
    {
        var end = url.IndexOf('?');
        var path = end < 0 ? url : url[..end];
        var decoded = Uri.UnescapeDataString(path);
        return path.StartsWith('/') && !decoded.StartsWith("//", StringComparison.Ordinal) &&
            !decoded.Split('/').Any(segment => segment is "." or "..") &&
            !url.Contains('#') && !url.Contains('\\') && !decoded.Contains('\\') &&
            !url.Any(character => char.IsWhiteSpace(character) || char.IsControl(character)) && !decoded.Any(char.IsControl);
    }

    internal static string WithPathBase(HttpRequest request, string url) => request.PathBase.ToUriComponent() + url;
}
