namespace Sendproof.Journeys;

/// <summary>An <see cref="ApprovedDifference{T}"/> without its type, for the expectations document.</summary>
internal interface IApprovedDifference
{
    string Id { get; }
    object? Actual { get; }
    Type ValueType { get; }
    string Reason { get; }
    string ApprovedBy { get; }
    DateOnly ApprovedOn { get; }
    DateOnly? Expires { get; }
    string? Link { get; }
}
