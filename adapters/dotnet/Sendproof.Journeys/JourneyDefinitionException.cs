namespace Sendproof.Journeys;

/// <summary>A journey definition that can't be turned into Arazzo, such as a member expression with a method call in it.</summary>
internal sealed class JourneyDefinitionException(string message) : Exception(message);
