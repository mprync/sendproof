namespace Sendproof.Journeys.Tests;

public static class ParcelApprovedDifferences
{
    public static readonly ApprovedDifference<string> BritishSpelling = new()
    {
        Id = "AD-0001",
        Actual = "Relabelled",
        Reason = "The API spells it the British way; the expectation was written the American way.",
        ApprovedBy = "sam.support@example.test",
        ApprovedOn = new DateOnly(2026, 11, 1),
        Expires = new DateOnly(2099, 12, 31),
    };
}
