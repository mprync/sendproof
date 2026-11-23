using System.Text.Json;

namespace Sendproof.Journeys;

/// <summary>Where a <see cref="Ref{T}"/> comes from: one of the journey's inputs, or an output of one of its steps.</summary>
internal sealed class JourneyRefSource
{
    private JourneyRefSource(JourneyModel journey, StepModel? step, MemberPath path, string? name)
    {
        Journey = journey;
        Step = step;
        Path = path;
        Name = name;
    }

    internal JourneyModel Journey { get; }

    /// <summary>Gets the step whose response it reads, or <see langword="null"/> for an input.</summary>
    internal StepModel? Step { get; }

    /// <summary>Gets the input property, or the response member the output reads.</summary>
    internal MemberPath Path { get; }

    /// <summary>Gets the output name the author chose, if any.</summary>
    internal string? Name { get; }

    internal static JourneyRefSource Input(JourneyModel journey, MemberPath input) => new(journey, null, input, null);

    internal static JourneyRefSource Output(JourneyModel journey, StepModel step, MemberPath member, string? name) =>
        new(journey, step, member, name);

    /// <summary>The input's or output's name: the explicit name, or the JSON name of the last member read.</summary>
    internal string ValueName(JsonSerializerOptions json) => Name ?? Path.Names(json)[^1];

    /// <summary>The Arazzo runtime expression, such as <c>$inputs.quantity</c> or <c>$steps.placeOrder.outputs.orderId</c>.</summary>
    internal string Expression(JsonSerializerOptions json) => Step is null
        ? $"$inputs.{ValueName(json)}"
        : $"$steps.{Step.StepId}.outputs.{ValueName(json)}";

    /// <summary>Describes it for a problem message.</summary>
    internal string Describe() => Step is null ? $"input {Path.Text}" : $"the output {Path.Text} of step {Step.StepId}";
}
