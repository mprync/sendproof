namespace Sendproof.Journeys;

/// <summary>An effect a step should hold or send, such as an email, matched to the Preview effects by kind and data.</summary>
internal sealed class ExpectedEffect(string kind)
{
    internal string Kind { get; } = kind;
    internal Dictionary<string, JourneyValue> Data { get; } = [];
}
