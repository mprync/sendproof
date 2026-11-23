namespace Sendproof.Journeys.Generators;

/// <summary>What one <c>Map*</c> call says about its operation, in a form the incremental pipeline can compare.</summary>
/// <param name="Name">The <c>WithName</c> value, or <see langword="null"/> when the endpoint has none.</param>
/// <param name="ImpliedName">The name used when it has none: its handler's action, or its method and route.</param>
/// <param name="Method">The HTTP method.</param>
/// <param name="Route">The route pattern, with any group prefix the generator could follow.</param>
/// <param name="Parameters">The request parameters and body.</param>
/// <param name="Response">The fully qualified type of its first successful <c>Produces&lt;T&gt;</c>, or <c>object</c>.</param>
/// <param name="Location">Where the call is, for diagnostics.</param>
internal sealed record EndpointInfo(string? Name, string ImpliedName, string Method, string Route,
    EquatableArray<RequestParameter> Parameters, string Response, LocationInfo Location);
