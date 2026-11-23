using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace Sendproof.AspNetCore;

/// <summary>
/// A Sendproof package that adds routes under <c>/sendproof</c> and entries to the capabilities response, such as
/// Sendproof.Journeys serving its Arazzo documents. Register implementations as singletons; the workbench maps and asks
/// each one only in the environments where Sendproof is enabled, behind the same authorization policy.
/// </summary>
internal interface IWorkbenchExtension
{
    /// <summary>Maps the extension's routes on the <c>/sendproof</c> route group.</summary>
    /// <param name="app">The application's route builder, whose data sources hold every endpoint the app maps.</param>
    /// <param name="workbench">The <c>/sendproof</c> route group.</param>
    void MapRoutes(IEndpointRouteBuilder app, IEndpointRouteBuilder workbench);

    /// <summary>Adds the extension's optional fields to the capabilities of the current request.</summary>
    ValueTask AddCapabilitiesAsync(HttpContext context, IDictionary<string, object?> capabilities);
}
