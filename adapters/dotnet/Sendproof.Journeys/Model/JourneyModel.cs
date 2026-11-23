namespace Sendproof.Journeys;

/// <summary>What a journey's <c>Define</c> described, before it becomes Arazzo and expectations.</summary>
internal sealed class JourneyModel(Type type, Type inputsType)
{
    internal Type Type { get; } = type;
    internal Type InputsType { get; } = inputsType;

    /// <summary>Gets or sets the Arazzo workflowId: the class name without <c>Journey</c>, camel-cased, unless set.</summary>
    internal string Id { get; set; } = DefaultId(type);

    internal string? Name { get; set; }
    internal string? Description { get; set; }
    internal string? Group { get; set; }
    internal string? RunAs { get; set; }
    internal List<StepModel> Steps { get; } = [];

    /// <summary>Gets the problems found while defining the journey; startup reports them all at once.</summary>
    internal List<string> Problems { get; } = [];

    /// <summary>
    /// Records a problem for each ref the value reads that this step can't have yet: one from another journey, from a
    /// later step, or (before the response) from this step.
    /// </summary>
    internal void Check(JourneyValue value, StepModel step, bool afterResponse, string where)
    {
        foreach (var source in value.References)
        {
            if (source.Journey != this)
            {
                Problems.Add($"Step {step.StepId}: {where} uses {source.Describe()}, which belongs to another journey.");
            }
            else if (source.Step is { } from && (from.Index > step.Index || from == step && !afterResponse))
            {
                Problems.Add($"Step {step.StepId}: {where} uses {source.Describe()}, which " +
                    (from == step ? "isn't known until this step's response." : "comes later in the journey."));
            }
        }
    }

    private static string DefaultId(Type type)
    {
        var name = type.Name.EndsWith("Journey", StringComparison.Ordinal) && type.Name.Length > "Journey".Length
            ? type.Name[..^"Journey".Length]
            : type.Name;
        return char.ToLowerInvariant(name[0]) + name[1..];
    }
}
