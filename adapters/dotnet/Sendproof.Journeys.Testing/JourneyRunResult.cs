using System.Text;

namespace Sendproof.Journeys.Testing;

/// <summary>One run of a journey: its mode, each step's result, and the approved differences it used.</summary>
/// <param name="JourneyId">The Arazzo workflowId.</param>
/// <param name="Name">The journey's name.</param>
/// <param name="Mode">The mode the steps ran in.</param>
/// <param name="Steps">Each step, in order; steps after a stop are <c>skipped</c>.</param>
/// <param name="Notes">Anything the run changed or couldn't do, such as sending a Send-only journey.</param>
public sealed record JourneyRunResult(string JourneyId, string Name, JourneyRunMode Mode, IReadOnlyList<JourneyStepResult> Steps,
    IReadOnlyList<string> Notes)
{
    /// <summary>Gets whether every step passed, with or without approved differences.</summary>
    public bool Passed => Steps.All(step => step.Verdict != "failed");

    /// <summary>Gets the approved differences the run used.</summary>
    public IReadOnlyList<string> ApprovedUsed => [.. Steps.SelectMany(step => step.Findings).SelectMany(finding => finding.ApprovedDifferences).Distinct()];

    /// <summary>A readable report: one line per step, with the problems under it.</summary>
    public string Report()
    {
        var report = new StringBuilder($"{Name} ({JourneyId}), {Mode}: {(Passed ? "passed" : "failed")}");
        foreach (var note in Notes)
        {
            report.Append($"{Environment.NewLine}  note: {note}");
        }

        foreach (var step in Steps)
        {
            report.Append($"{Environment.NewLine}  {step.StepId} ({step.OperationId}): {step.Status}{(step.HttpStatus is { } status ? $" {status}" : "")}, {step.Verdict}");
            if (step.Detail is { } detail)
            {
                report.Append($"{Environment.NewLine}    {detail}");
            }

            foreach (var criterion in step.Criteria.Where(criterion => !criterion.Passed))
            {
                report.Append($"{Environment.NewLine}    criterion failed: {criterion.Condition} (read {criterion.Actual?.ToJsonString() ?? "null"})");
            }

            foreach (var finding in step.Findings.Where(finding => finding.Kind != "match"))
            {
                report.Append($"{Environment.NewLine}    {finding}");
            }
        }

        return report.ToString();
    }
}
