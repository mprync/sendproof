namespace Sendproof.Journeys;

/// <summary>
/// The base of every journey. Derive from <see cref="Journey{TInputs}"/>; this non-generic base lets
/// <c>AddJourney&lt;TJourney&gt;()</c> accept any journey whatever its inputs.
/// </summary>
public abstract class Journey
{
    private protected Journey()
    {
    }

    /// <summary>Runs the journey's definition and returns what it described, with any problems found on the way.</summary>
    internal abstract JourneyModel Describe();
}
