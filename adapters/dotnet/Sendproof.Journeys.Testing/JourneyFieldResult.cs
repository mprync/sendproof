using System.Text.Json.Nodes;

namespace Sendproof.Journeys.Testing;

/// <summary>One field of a compared write: what was expected, what was written, and whether they agree.</summary>
/// <param name="Name">The column, field or key part.</param>
/// <param name="State"><c>match</c>, <c>differs</c> or <c>approved</c>.</param>
/// <param name="Expected">The expected value as the expectations document gives it, with runtime expressions evaluated.</param>
/// <param name="Actual">The written value.</param>
public sealed record JourneyFieldResult(string Name, string State, JsonNode? Expected, JsonNode? Actual);
