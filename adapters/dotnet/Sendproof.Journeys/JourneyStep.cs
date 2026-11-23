using System.Linq.Expressions;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.Metadata;

namespace Sendproof.Journeys;

/// <summary>
/// One step of a journey. <c>Set</c> binds a request member to a value, <c>Output</c> reads a response member for
/// later steps, <c>SucceedsWith</c> and <c>ExpectResponse</c> become Arazzo <c>successCriteria</c>, and
/// <c>ExpectWrites</c> says what the step should write.
/// </summary>
/// <typeparam name="TRequest">The operation's request: parameters and <c>Body</c>.</typeparam>
/// <typeparam name="TResponse">The operation's response body.</typeparam>
public sealed class JourneyStep<TRequest, TResponse>
{
    private readonly JourneyModel _journey;
    private readonly StepModel _step;

    internal JourneyStep(JourneyModel journey, StepModel step)
    {
        _journey = journey;
        _step = step;
    }

    /// <summary>Sends a fixed value in a request member, such as <c>Set(r =&gt; r.Body.NotifyCustomer, true)</c>.</summary>
    public void Set<TValue>(Expression<Func<TRequest, TValue>> member, TValue value) =>
        Bind(member, JourneyValue.Literal(value, typeof(TValue)));

    /// <summary>Sends an input or an earlier step's output in a request member, optional or not.</summary>
    public void Set<TValue>(Expression<Func<TRequest, TValue?>> member, Ref<TValue> value) =>
        Bind(member, JourneyValue.Reference(Required(value).Source));

    /// <summary>Sends an input or an earlier step's output in an optional value-type request member.</summary>
    public void Set<TValue>(Expression<Func<TRequest, TValue?>> member, Ref<TValue> value) where TValue : struct =>
        Bind(member, JourneyValue.Reference(Required(value).Source));

    /// <summary>Reads a member of the response for later steps, such as <c>Output(order =&gt; order.Id, "orderId")</c>.</summary>
    /// <param name="member">The response member.</param>
    /// <param name="name">The output's name; the member's JSON name when left out.</param>
    public Ref<TValue> Output<TValue>(Expression<Func<TResponse, TValue>> member, string? name = null)
    {
        ArgumentNullException.ThrowIfNull(member);
        var source = JourneyRefSource.Output(_journey, _step, MemberPath.Parse(member), name);
        _step.Outputs.Add(source);
        return new Ref<TValue>(source);
    }

    /// <summary>Succeeds when the response has this status: <c>$statusCode == 201</c>. Use 409 for an expected refusal.</summary>
    public void SucceedsWith(int statusCode)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(statusCode, 100);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(statusCode, 599);
        _step.Criteria.Add(_ => $"$statusCode == {statusCode}");
    }

    /// <summary>Succeeds when a single value of the response equals <paramref name="expected"/>.</summary>
    public void ExpectResponse<TValue>(Expression<Func<TResponse, TValue>> member, TValue expected)
    {
        ArgumentNullException.ThrowIfNull(member);
        var path = MemberPath.Parse(member);
        _step.Criteria.Add(json => $"$response.body#{path.Pointer(json)} == {Literal(JsonSerializer.SerializeToNode(expected, typeof(TValue), json), path)}");
    }

    /// <summary>Says what the step should write, store by store, and which effects it should hold or send.</summary>
    public void ExpectWrites(Action<StepWrites> describe)
    {
        ArgumentNullException.ThrowIfNull(describe);
        describe(_step.Writes ??= new StepWrites(_journey, _step));
    }

    /// <summary>Runs this step as another persona (by email) than the journey's.</summary>
    public void RunAs(string personaEmail)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(personaEmail);
        _step.RunAs = personaEmail;
    }

    private void Bind(LambdaExpression member, JourneyValue value)
    {
        ArgumentNullException.ThrowIfNull(member);
        var path = MemberPath.Parse(member);
        var root = path.Root;
        if (root.GetCustomAttributes().OfType<IFromBodyMetadata>().Any())
        {
            if (path.Segments.Count == 1 && _step.Body.Count > 0)
            {
                _journey.Problems.Add($"Step {_step.StepId}: set the whole body before its members.");
            }

            _step.Body.Add(new RequestValue(path, value));
        }
        else if (path.Segments.Count == 1 && root.GetCustomAttributes().Any(attribute =>
            attribute is IFromQueryMetadata or IFromRouteMetadata or IFromHeaderMetadata))
        {
            _step.Parameters.Add(new RequestValue(path, value));
        }
        else
        {
            throw new JourneyDefinitionException($"Step {_step.StepId}: {member} must name a parameter or a member of Body.");
        }

        _journey.Check(value, _step, afterResponse: false, path.Text);
    }

    private static Ref<TValue> Required<TValue>(Ref<TValue> value) => value ?? throw new ArgumentNullException(nameof(value));

    /// <summary>An Arazzo literal: strings in single quotes (a quote doubled), numbers, booleans and null as they are.</summary>
    private static string Literal(JsonNode? value, MemberPath path) => value?.GetValueKind() switch
    {
        null or JsonValueKind.Null => "null",
        JsonValueKind.String => $"'{value.GetValue<string>().Replace("'", "''", StringComparison.Ordinal)}'",
        JsonValueKind.Number or JsonValueKind.True or JsonValueKind.False => value.ToJsonString(),
        _ => throw new JourneyDefinitionException($"ExpectResponse compares one value; {path.Text} is an object or array.")
    };
}
