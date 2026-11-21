using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.OutputCaching;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.Routing.Patterns;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Sendproof.AspNetCore;

internal static class WorkbenchEndpoints
{
    internal static void Map(WebApplication app, SendproofOptions options)
    {
        var routes = app.MapGroup("/sendproof").ExcludeFromDescription();
        if (options.AuthorizationPolicy is { } policy)
        {
            routes.RequireAuthorization(policy);
        }

        routes.MapGet("", (HttpContext context) => context.Request.Path.Value!.EndsWith('/')
            ? WorkbenchAssets.Serve(context, "index.html")
            : Results.LocalRedirect(LocalUrl.WithPathBase(context.Request, "/sendproof/") + context.Request.QueryString));
        routes.MapGet("/signin.html", (HttpContext context) => WorkbenchAssets.Serve(context, "index.html"));
        routes.MapGet("/_api/capabilities", CapabilitiesAsync);
        routes.MapGet("/_api/traces/{id:guid}", TraceAsync).WithMetadata(new OutputCacheAttribute { NoStore = true });
        routes.MapGet("/_api/challenge", WorkbenchAuthentication.ChallengeAsync);
        routes.MapGet("/{**asset}", (HttpContext context, string asset) => WorkbenchAssets.Serve(context, asset));
    }

    private static async Task<IResult> CapabilitiesAsync(HttpContext context, SendproofOptions options,
        IHostEnvironment environment, EndpointDataSource endpoints)
    {
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers.XContentTypeOptions = "nosniff";
        var provider = PreviewEndpointPolicy.GetProvider(context);
        var apiName = options.ApiName ?? environment.ApplicationName;
        var openApiUrl = LocalUrl.WithPathBase(context.Request, options.OpenApiUrl);
        var documents = options.Documents.Select(document => document with
        {
            Url = LocalUrl.WithPathBase(context.Request, document.Url)
        }).ToList();
        if (documents.All(document => document.Url != openApiUrl))
        {
            documents.Insert(0, new OpenApiDocument(apiName, openApiUrl));
        }

        // A host with only data stores (no SQL provider) can Preview, so it advertises operations too.
        var stores = PreviewEndpointPolicy.GetDataStores(context);
        var canPreview = provider is not null || stores.Count > 0;
        var marked = !canPreview ? [] : endpoints.Endpoints.OfType<RouteEndpoint>()
            .Select(endpoint => (Endpoint: endpoint, Mark: endpoint.Metadata.GetMetadata<SendproofPreviewAttribute>()))
            .Where(item => item.Mark is not null)
            .SelectMany(item => (item.Endpoint.Metadata.GetMetadata<IHttpMethodMetadata>()?.HttpMethods ?? [])
                .Where(method => !HttpMethods.IsHead(method))
                .Select(method => (Operation: new PreviewOperation(method, OpenApiPath(item.Endpoint.RoutePattern)), Mark: item.Mark!)))
            .DistinctBy(item => item.Operation)
            .OrderBy(item => item.Operation.Path, StringComparer.Ordinal)
            .ThenBy(item => item.Operation.Method, StringComparer.Ordinal)
            .ToArray();
        var operations = marked.Where(item => item.Mark.Enabled).Select(item => item.Operation).ToArray();
        // Operations an API author marked preview: false. They are never inferred, and never in previewOperations.
        var unavailable = marked.Where(item => !item.Mark.Enabled).Select(item => new UnavailableOperation(
            item.Operation.Method, item.Operation.Path, item.Mark.Reason ?? "Preview is not available for this operation",
            item.Mark.Stores is { Length: > 0 } ? item.Mark.Stores : null)).ToArray();
        var dataStores = await Task.WhenAll(stores.Select(store => store.DescribeAsync(context.RequestAborted).AsTask()));
        var identity = context.User.Identities.FirstOrDefault(identity => identity.IsAuthenticated);

        var capabilities = new Dictionary<string, object?>
        {
            ["protocolVersion"] = 1,
            ["openApiUrl"] = openApiUrl,
            ["fieldModules"] = options.FieldModules.Select(url => LocalUrl.WithPathBase(context.Request, url)),
            ["apiName"] = apiName,
            ["environment"] = environment.EnvironmentName,
            ["database"] = provider is null ? null : new DatabaseInfo(provider.Database, provider.DatabaseSystem),
            ["binding"] = new { language = "dotnet", framework = "ASP.NET Core" },
            ["identity"] = identity is null ? null : new WorkbenchIdentity(identity.Name, identity.FindFirst(identity.RoleClaimType)?.Value),
            ["authProviders"] = await WorkbenchAuthentication.DiscoverAsync(context, options),
            ["previewOperations"] = operations,
            ["observedSend"] = operations.Length > 0 || unavailable.Length > 0,
            ["documents"] = documents
        };
        // Optional arrays are left out, not null: discovery lists only what the host has.
        if (unavailable.Length > 0)
        {
            capabilities["previewUnavailable"] = unavailable;
        }

        if (dataStores.Length > 0)
        {
            capabilities["dataStores"] = dataStores;
        }

        return Results.Json(capabilities, PreviewProtocol.JsonOptions);
    }

    private static async Task<IResult> TraceAsync(HttpContext context, Guid id, ObservedTraceStore store)
    {
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers.XContentTypeOptions = "nosniff";
        if (!PreviewProtocol.IsSameOrigin(context.Request) || TraceOwner.From(context) is not { } owner)
        {
            return Results.NotFound();
        }

        var trace = await store.ReadAsync(id, owner, context.RequestAborted);
        return trace is null ? Results.NotFound() : Results.Json(trace, PreviewProtocol.JsonOptions);
    }

    private static string OpenApiPath(RoutePattern pattern) => "/" + string.Join('/', pattern.PathSegments.Select(segment =>
        string.Concat(segment.Parts.Select(part => part switch
        {
            RoutePatternParameterPart parameter => "{" + parameter.Name + "}",
            RoutePatternLiteralPart literal => literal.Content,
            RoutePatternSeparatorPart separator => separator.Content,
            _ => ""
        }))));

    private sealed record PreviewOperation(string Method, string Path);

    private sealed record UnavailableOperation(string Method, string Path, string Reason,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string[]? Stores);

    private sealed record DatabaseInfo(string? Name,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? System);

    private sealed record WorkbenchIdentity(string? Name, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Role);
}
