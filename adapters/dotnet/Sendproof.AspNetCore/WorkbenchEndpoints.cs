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

        var operations = provider is null ? [] : endpoints.Endpoints.OfType<RouteEndpoint>()
            .Where(endpoint => endpoint.Metadata.GetMetadata<SendproofPreviewAttribute>() is not null)
            .SelectMany(endpoint => (endpoint.Metadata.GetMetadata<IHttpMethodMetadata>()?.HttpMethods ?? [])
                .Where(method => !HttpMethods.IsHead(method))
                .Select(method => new PreviewOperation(method, OpenApiPath(endpoint.RoutePattern))))
            .Distinct()
            .OrderBy(operation => operation.Path, StringComparer.Ordinal)
            .ThenBy(operation => operation.Method, StringComparer.Ordinal)
            .ToArray();
        var identity = context.User.Identities.FirstOrDefault(identity => identity.IsAuthenticated);

        return Results.Json(new
        {
            protocolVersion = 1,
            openApiUrl,
            fieldModules = options.FieldModules.Select(url => LocalUrl.WithPathBase(context.Request, url)),
            apiName,
            environment = environment.EnvironmentName,
            database = provider?.Database,
            identity = identity is null ? null : new WorkbenchIdentity(identity.Name, identity.FindFirst(identity.RoleClaimType)?.Value),
            authProviders = await WorkbenchAuthentication.DiscoverAsync(context, options),
            previewOperations = operations,
            observedSend = operations.Length > 0,
            documents
        }, PreviewProtocol.JsonOptions);
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

    private sealed record WorkbenchIdentity(string? Name, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Role);
}
