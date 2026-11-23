using System.Text.Json;

namespace Sendproof.Journeys;

/// <summary>One step as described: the operation it calls, its bound values, outputs, criteria and expected writes.</summary>
internal sealed class StepModel(string stepId, int index, string operationId, string method)
{
    internal string StepId { get; } = stepId;
    internal int Index { get; } = index;
    internal string OperationId { get; } = operationId;
    internal string Method { get; } = method;
    internal List<RequestValue> Parameters { get; } = [];
    internal List<RequestValue> Body { get; } = [];
    internal List<JourneyRefSource> Outputs { get; } = [];

    /// <summary>Gets the Arazzo success criteria, each written once the app's JSON options are known.</summary>
    internal List<Func<JsonSerializerOptions, string>> Criteria { get; } = [];

    internal StepWrites? Writes { get; set; }
    internal string? RunAs { get; set; }
}
