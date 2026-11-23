using System.Text.Json;

namespace Sendproof.Journeys;

/// <summary>
/// What a <see cref="JourneyValue"/> needs to become JSON: the app's JSON options (for names in expressions) and the
/// serializer of the place the value goes.
/// </summary>
internal sealed record JourneyValueContext(JsonSerializerOptions Json, ValueSerializer Serialize);
