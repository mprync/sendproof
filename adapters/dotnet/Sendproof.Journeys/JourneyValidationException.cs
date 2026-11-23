namespace Sendproof.Journeys;

/// <summary>
/// Stops startup in Development when a journey is wrong, with every problem found: an output read before its step, two
/// steps or journeys with one ID, a ref from another journey, an operation no endpoint is named, a table or field the
/// model doesn't have. Elsewhere the same problems are logged and the journey is skipped.
/// </summary>
public sealed class JourneyValidationException : Exception
{
    /// <summary>Creates the exception for the problems found.</summary>
    public JourneyValidationException(IReadOnlyList<string> problems)
        : base($"Sendproof found {problems.Count} problem{(problems.Count == 1 ? "" : "s")} in the journeys:{Environment.NewLine}" +
            string.Join(Environment.NewLine, problems.Select(problem => "- " + problem)))
    {
        Problems = problems;
    }

    /// <summary>Gets the problems, one sentence each, starting with the journey or file they belong to.</summary>
    public IReadOnlyList<string> Problems { get; }
}
