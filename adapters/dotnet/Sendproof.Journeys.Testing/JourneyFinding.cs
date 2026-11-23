namespace Sendproof.Journeys.Testing;

/// <summary>The outcome for one expected write or effect, or for one write nobody expected.</summary>
/// <param name="Kind"><c>match</c>, <c>differs</c>, <c>missing</c>, <c>extra</c>, <c>approved</c> or <c>unchecked</c>.</param>
/// <param name="Store">The store id, or <c>effect</c> for an effect.</param>
/// <param name="Target">The table, collection, key or effect kind.</param>
/// <param name="Operation">The operation or command.</param>
/// <param name="Fields">The compared fields.</param>
/// <param name="ApprovedDifferences">The IDs of the approved differences it used.</param>
/// <param name="Note">Why it couldn't be checked, or which approved difference expired.</param>
public sealed record JourneyFinding(string Kind, string Store, string Target, string Operation,
    IReadOnlyList<JourneyFieldResult> Fields, IReadOnlyList<string> ApprovedDifferences, string? Note = null)
{
    /// <summary>Gets whether the finding fails its step.</summary>
    public bool Fails => Kind is "differs" or "missing" or "extra";

    /// <inheritdoc />
    public override string ToString()
    {
        var fields = string.Join(", ", Fields.Where(field => field.State != "match")
            .Select(field => $"{field.Name}: expected {field.Expected?.ToJsonString() ?? "null"}, written {field.Actual?.ToJsonString() ?? "null"}" +
                (field.State == "approved" ? " (approved)" : "")));
        return $"{Kind} {Operation} {Store} {Target}" + (fields.Length > 0 ? $" [{fields}]" : "") +
            (ApprovedDifferences.Count > 0 ? $" via {string.Join(", ", ApprovedDifferences)}" : "") + (Note is null ? "" : $" ({Note})");
    }
}
