using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Sendproof.AspNetCore;

namespace Sendproof.Journeys;

/// <summary>
/// Serves the journey documents at <c>/sendproof/journeys/{name}.arazzo.json</c> and <c>…/{name}.expect.json</c>, and
/// lists them in capabilities as <c>journeys</c>, with URLs that include any path base.
/// </summary>
internal sealed class JourneyWorkbench(JourneyDocuments documents) : IWorkbenchExtension
{
    public void MapRoutes(IEndpointRouteBuilder app, IEndpointRouteBuilder workbench)
    {
        documents.Routes = app.DataSources;
        // Only the journey documents: the workbench's own engine modules live under /sendproof/journeys/ too
        // (ui/journeys/*.js), and must fall through to the embedded assets.
        workbench.MapGet("/journeys/{file:regex(^[^/]+\\.(arazzo|expect)\\.json$)}", Serve);
    }

    public ValueTask AddCapabilitiesAsync(HttpContext context, IDictionary<string, object?> capabilities)
    {
        if (documents.Documents.Count > 0)
        {
            capabilities["journeys"] = documents.Documents.Select(document => new
            {
                name = document.Name,
                arazzoUrl = Url(context, document.ArazzoFile),
                expectationsUrl = Url(context, document.ExpectationsFile),
                source = document.Source
            }).ToList();
        }

        return ValueTask.CompletedTask;
    }

    private IResult Serve(HttpContext context, string file)
    {
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers.XContentTypeOptions = "nosniff";
        if (documents.Documents.FirstOrDefault(document => document.ExpectationsFile == file) is { } expectations)
        {
            return Results.Content(expectations.Expectations.ToJsonString(), "application/json");
        }

        if (documents.Documents.FirstOrDefault(document => document.ArazzoFile == file) is not { } arazzo)
        {
            return Results.NotFound();
        }

        // The OpenAPI document is named by the URL it is served at, which includes the request's path base.
        var served = arazzo.Arazzo.DeepClone();
        if (context.Request.PathBase.HasValue && served["sourceDescriptions"] is JsonArray sources)
        {
            foreach (var source in sources.OfType<JsonObject>())
            {
                if (source["url"]?.GetValue<string>() is { } url && url.StartsWith('/'))
                {
                    source["url"] = LocalUrl.WithPathBase(context.Request, url);
                }
            }
        }

        return Results.Content(served.ToJsonString(), "application/json");
    }

    private static string Url(HttpContext context, string file) => LocalUrl.WithPathBase(context.Request, "/sendproof/journeys/" + file);
}
