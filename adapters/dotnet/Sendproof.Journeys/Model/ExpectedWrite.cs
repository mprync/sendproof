using System.Text.Json.Nodes;

namespace Sendproof.Journeys;

/// <summary>One write a step should make to one store, as the expectations document lists it.</summary>
internal abstract class ExpectedWrite
{
    /// <summary>Gets whether the store can't roll back, which makes the journey Send only.</summary>
    internal abstract bool IsGuarded { get; }

    /// <summary>The write in the expectations document, or <see langword="null"/> after recording why it can't be.</summary>
    internal abstract JsonObject? Describe(JourneyGeneration generation, StepWrites step);
}
