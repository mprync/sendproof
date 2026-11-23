namespace Sendproof.Journeys;

/// <summary>Everything registered with <c>AddJourneys</c>, <c>AddJourney</c> and <c>WithJourneys</c>, read once at startup.</summary>
internal sealed class JourneyRegistry
{
    internal JourneyOptions Options { get; } = new();
    internal List<Type> Journeys { get; } = [];
    internal List<JourneyFile> Files { get; } = [];
}
