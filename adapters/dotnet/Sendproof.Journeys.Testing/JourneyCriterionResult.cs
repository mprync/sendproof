using System.Text.Json.Nodes;

namespace Sendproof.Journeys.Testing;

/// <summary>One Arazzo success criterion of a step: the condition, whether it held, and the value it read.</summary>
public sealed record JourneyCriterionResult(string Condition, bool Passed, JsonNode? Actual);
