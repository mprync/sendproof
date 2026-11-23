namespace Sendproof.Journeys.Tests;

/// <summary>Registers a parcel.</summary>
public sealed class RegisterParcelRequest
{
    public string Label { get; set; } = "";
    public bool NotifyOwner { get; set; }
}

/// <summary>Changes a parcel's label.</summary>
public sealed class RelabelRequest
{
    public string Label { get; set; } = "";
}

/// <summary>A parcel as the API returns it.</summary>
public sealed class ParcelView
{
    public Guid Id { get; set; }
    public string Label { get; set; } = "";
    public string Status { get; set; } = "";
}
