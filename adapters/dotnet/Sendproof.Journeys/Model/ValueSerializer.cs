using System.Text.Json.Nodes;

namespace Sendproof.Journeys;

/// <summary>Turns a literal of a declared type into the JSON its destination stores or sends.</summary>
internal delegate JsonNode? ValueSerializer(object? value, Type type);
