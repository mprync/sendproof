namespace Sendproof.Journeys.Tests;

/// <summary>The inputs of the parcel journeys.</summary>
public sealed class ParcelInputs
{
    /// <summary>The label the parcel is registered with.</summary>
    public string Label { get; set; } = "Blue box";

    /// <summary>The label it gets afterwards.</summary>
    public string NewLabel { get; set; } = "Red box";
}
