using Microsoft.AspNetCore.Routing;

namespace Sendproof.Journeys;

/// <summary>The documents built at startup, served and listed in capabilities for the life of the process.</summary>
internal sealed class JourneyDocuments
{
    /// <summary>
    /// Gets or sets the app's endpoint data sources, taken from the app's route builder when the workbench is mapped. The
    /// <see cref="EndpointDataSource"/> service only sees them once the request pipeline is built, after startup checks.
    /// </summary>
    internal ICollection<EndpointDataSource> Routes { get; set; } = [];

    internal IReadOnlyList<JourneyDocument> Documents { get; private set; } = [];

    internal void Publish(IReadOnlyList<JourneyDocument> documents) => Documents = documents;
}
