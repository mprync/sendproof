using System.Text.Json.Nodes;

namespace Sendproof.Journeys.Testing;

/// <summary>What one step did: its status, response, success criteria and the comparison of its writes.</summary>
/// <param name="StepId">The step.</param>
/// <param name="OperationId">The operation it called.</param>
/// <param name="Status"><c>passed</c>, <c>failed</c>, <c>refused</c>, <c>blocked</c> or <c>skipped</c>.</param>
/// <param name="HttpStatus">The response status, if it ran.</param>
/// <param name="Criteria">Each success criterion, whether it held and the value it read.</param>
/// <param name="Findings">The comparison of the step's writes and effects with its expectations.</param>
/// <param name="Outputs">The outputs it bound for later steps.</param>
/// <param name="Detail">Why it was refused, blocked or failed to run.</param>
public sealed record JourneyStepResult(string StepId, string OperationId, string Status, int? HttpStatus,
    IReadOnlyList<JourneyCriterionResult> Criteria, IReadOnlyList<JourneyFinding> Findings,
    JsonObject Outputs, string? Detail = null)
{
    /// <summary>Gets the step's verdict: <c>passed</c>, <c>passed-approved</c> or <c>failed</c>.</summary>
    public string Verdict => Status != "passed" || Findings.Any(finding => finding.Fails) ? "failed"
        : Findings.Any(finding => finding.ApprovedDifferences.Count > 0) ? "passed-approved" : "passed";
}
