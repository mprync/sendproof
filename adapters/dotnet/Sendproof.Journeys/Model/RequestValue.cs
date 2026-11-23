namespace Sendproof.Journeys;

/// <summary>A value bound to a request member: a parameter, or a place in the body.</summary>
internal sealed record RequestValue(MemberPath Target, JourneyValue Value);
