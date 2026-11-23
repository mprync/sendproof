using System.Linq.Expressions;
using System.Text.RegularExpressions;

namespace Sendproof.Journeys;

/// <summary>Describes one journey: its name and group, who it runs as, its inputs and its steps.</summary>
/// <typeparam name="TInputs">The journey's inputs class.</typeparam>
public sealed partial class JourneyBuilder<TInputs> where TInputs : class, new()
{
    internal JourneyBuilder(Type journeyType) => Model = new JourneyModel(journeyType, typeof(TInputs));

    internal JourneyModel Model { get; }

    /// <summary>Sets the Arazzo workflowId. The default is the class name without <c>Journey</c>, camel-cased.</summary>
    public void Id(string workflowId)
    {
        Model.Id = ValidId(workflowId, nameof(workflowId));
    }

    /// <summary>Sets the name people see, such as "Order to shipment". It is the workflow's Arazzo <c>summary</c>.</summary>
    public void Name(string name)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        Model.Name = name;
    }

    /// <summary>Sets a longer description, in Markdown.</summary>
    public void Description(string description)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(description);
        Model.Description = description;
    }

    /// <summary>Sets the sidebar group the journey is listed under, such as "Checkout and fulfilment".</summary>
    public void Group(string group)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(group);
        Model.Group = group;
    }

    /// <summary>Sets the persona (by email) every step runs as, unless a step says otherwise.</summary>
    public void RunAs(string personaEmail)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(personaEmail);
        Model.RunAs = personaEmail;
    }

    /// <summary>Reads one of the journey's inputs, such as <c>journey.Input(i =&gt; i.Quantity)</c>.</summary>
    public Ref<T> Input<T>(Expression<Func<TInputs, T>> input)
    {
        ArgumentNullException.ThrowIfNull(input);
        var path = MemberPath.Parse(input);
        if (path.Segments.Count != 1)
        {
            throw new JourneyDefinitionException($"{input} must name one property of {typeof(TInputs).Name}.");
        }

        return new Ref<T>(JourneyRefSource.Input(Model, path));
    }

    /// <summary>Adds a step that calls an operation from the generated operations catalog.</summary>
    /// <param name="stepId">The Arazzo stepId, unique in the journey: letters, digits, <c>_</c> and <c>-</c>.</param>
    /// <param name="operation">The operation, such as <c>StoreOperations.Orders.Place</c>.</param>
    public JourneyStep<TRequest, TResponse> Step<TRequest, TResponse>(string stepId, JourneyOperation<TRequest, TResponse> operation)
    {
        ArgumentNullException.ThrowIfNull(operation);
        ValidId(stepId, nameof(stepId));
        if (Model.Steps.Any(step => step.StepId == stepId))
        {
            Model.Problems.Add($"Two steps have the ID {stepId}.");
        }

        var step = new StepModel(stepId, Model.Steps.Count, operation.OperationId, operation.Method);
        Model.Steps.Add(step);
        return new JourneyStep<TRequest, TResponse>(Model, step);
    }

    private static string ValidId(string id, string parameter)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(id, parameter);
        return ArazzoId().IsMatch(id) ? id
            : throw new ArgumentException($"{id} can use only letters, digits, _ and -, as Arazzo requires.", parameter);
    }

    [GeneratedRegex("^[A-Za-z0-9_\\-]+$")]
    private static partial Regex ArazzoId();
}
