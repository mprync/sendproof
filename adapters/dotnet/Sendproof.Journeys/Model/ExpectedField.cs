namespace Sendproof.Journeys;

/// <summary>A key or value of an expected write, with the approved difference that relaxes it, if any.</summary>
internal sealed record ExpectedField(MemberPath Member, JourneyValue Value, IApprovedDifference? Approved = null);
