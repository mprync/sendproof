namespace Sendproof.Journeys;

/// <summary>
/// A reviewed record that allows one known difference between what a step should write and what it writes. Pass it
/// to the expectation it relaxes, so its review happens next to it: <c>.Set(s =&gt; s.Carrier, "DHL", CarrierRenamed)</c>.
/// Its <see cref="Actual"/> has the field's type. An expired record covers nothing, and the run says so.
/// </summary>
/// <typeparam name="T">The type of the field it relaxes.</typeparam>
public sealed class ApprovedDifference<T> : IApprovedDifference
{
    /// <summary>Gets the record's ID, such as <c>AD-0011</c>.</summary>
    public required string Id { get; init; }

    /// <summary>Gets the value the step writes instead of the expected one.</summary>
    public required T Actual { get; init; }

    /// <summary>Gets why the difference is allowed.</summary>
    public required string Reason { get; init; }

    /// <summary>Gets who approved it.</summary>
    public required string ApprovedBy { get; init; }

    /// <summary>Gets the day it was approved.</summary>
    public required DateOnly ApprovedOn { get; init; }

    /// <summary>Gets the day it stops covering anything, if it has one.</summary>
    public DateOnly? Expires { get; init; }

    /// <summary>Gets a link to the issue or discussion behind it.</summary>
    public string? Link { get; init; }

    object? IApprovedDifference.Actual => Actual;
    Type IApprovedDifference.ValueType => typeof(T);
}
