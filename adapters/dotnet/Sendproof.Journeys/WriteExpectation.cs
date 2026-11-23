using System.Linq.Expressions;

namespace Sendproof.Journeys;

/// <summary>
/// One expected insert, update or delete of a row or document. <c>Where</c> names the key that finds it, <c>Set</c>
/// the values it should have. Members are the entity's or document class's own properties, so their names come from
/// the store's model and their values must have the property's type.
/// </summary>
/// <typeparam name="TRow">The entity or document class.</typeparam>
public sealed class WriteExpectation<TRow>
{
    private readonly StepWrites _writes;
    private readonly FieldWrite _write;

    internal WriteExpectation(StepWrites writes, FieldWrite write)
    {
        _writes = writes;
        _write = write;
    }

    /// <summary>The row or document is found by this fixed key value.</summary>
    public WriteExpectation<TRow> Where<TValue>(Expression<Func<TRow, TValue>> member, TValue value) =>
        Add(_write.Key, member, JourneyValue.Literal(value, typeof(TValue)));

    /// <summary>The row or document is found by an input or an output, such as the order's ID.</summary>
    public WriteExpectation<TRow> Where<TValue>(Expression<Func<TRow, TValue?>> member, Ref<TValue> value) =>
        Add(_write.Key, member, JourneyValue.Reference(value.Source));

    /// <summary>The row or document is found by an input or an output, in an optional value-type key column.</summary>
    public WriteExpectation<TRow> Where<TValue>(Expression<Func<TRow, TValue?>> member, Ref<TValue> value) where TValue : struct =>
        Add(_write.Key, member, JourneyValue.Reference(value.Source));

    /// <summary>The field has this value.</summary>
    public WriteExpectation<TRow> Set<TValue>(Expression<Func<TRow, TValue>> member, TValue value) =>
        Add(_write.Values, member, JourneyValue.Literal(value, typeof(TValue)));

    /// <summary>
    /// The field has <paramref name="expected"/>, except that an approved difference allows its <c>Actual</c> instead
    /// until it expires.
    /// </summary>
    public WriteExpectation<TRow> Set<TValue>(Expression<Func<TRow, TValue>> member, TValue expected, ApprovedDifference<TValue> approved)
    {
        ArgumentNullException.ThrowIfNull(approved);
        return Add(_write.Values, member, JourneyValue.Literal(expected, typeof(TValue)), approved);
    }

    /// <summary>The field has an input's or an output's value.</summary>
    public WriteExpectation<TRow> Set<TValue>(Expression<Func<TRow, TValue?>> member, Ref<TValue> value) =>
        Add(_write.Values, member, JourneyValue.Reference(value.Source));

    /// <summary>The optional value-type field has an input's or an output's value.</summary>
    public WriteExpectation<TRow> Set<TValue>(Expression<Func<TRow, TValue?>> member, Ref<TValue> value) where TValue : struct =>
        Add(_write.Values, member, JourneyValue.Reference(value.Source));

    /// <summary>The field matches, such as <c>Match.Any&lt;DateTimeOffset&gt;()</c> or <c>Match.Changed(from, to)</c>.</summary>
    public WriteExpectation<TRow> Set<TValue>(Expression<Func<TRow, TValue>> member, Matcher<TValue> value) =>
        Add(_write.Values, member, value.Value);

    /// <summary>The optional field matches, such as <c>Match.Any&lt;DateTimeOffset&gt;()</c>.</summary>
    public WriteExpectation<TRow> Set<TValue>(Expression<Func<TRow, TValue?>> member, Matcher<TValue> value) where TValue : struct =>
        Add(_write.Values, member, value.Value);

    private WriteExpectation<TRow> Add(List<ExpectedField> fields, LambdaExpression member, JourneyValue value, IApprovedDifference? approved = null)
    {
        ArgumentNullException.ThrowIfNull(member);
        var path = MemberPath.Parse(member);
        if (path.Segments.Count != 1)
        {
            throw new JourneyDefinitionException($"{member} must name one property of {typeof(TRow).Name}.");
        }

        _writes.Check(value, path.Text);
        fields.Add(new ExpectedField(path, value, approved));
        return this;
    }
}
