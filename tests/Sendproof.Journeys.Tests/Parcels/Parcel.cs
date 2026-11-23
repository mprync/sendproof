namespace Sendproof.Journeys.Tests;

/// <summary>A parcel row of the test API.</summary>
public sealed class Parcel
{
    public Guid Id { get; set; }
    public string Label { get; set; } = "";
    public string Status { get; set; } = "";
    public DateTimeOffset CreatedAt { get; set; }
}
