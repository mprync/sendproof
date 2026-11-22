using System.ComponentModel.DataAnnotations;

namespace StoreApi;

/// <summary>One scan of a parcel.</summary>
public sealed class TrackingEvent
{
    /// <summary>When the carrier scanned the parcel.</summary>
    public required DateTimeOffset At { get; init; }
    /// <summary>Where the parcel was scanned.</summary>
    public required string Location { get; init; }
    /// <summary>What happened.</summary>
    public required string Description { get; init; }
}

/// <summary>A parcel on its way to a customer.</summary>
public sealed class Shipment
{
    /// <summary>The shipment's ID.</summary>
    public required Guid Id { get; init; }
    /// <summary>The order shipped.</summary>
    public required Guid OrderId { get; init; }
    /// <summary>The order's number.</summary>
    public required string OrderNumber { get; init; }
    /// <summary>The carrier.</summary>
    public required Carrier Carrier { get; init; }
    /// <summary>The carrier's tracking number.</summary>
    public required string TrackingNumber { get; init; }
    /// <summary>Where the parcel is.</summary>
    public required ShipmentStatus Status { get; init; }
    /// <summary>The scans so far, oldest first.</summary>
    public required IReadOnlyList<TrackingEvent> Events { get; init; }
    /// <summary>When the parcel was handed to the carrier.</summary>
    public required DateTimeOffset ShippedAt { get; init; }
    /// <summary>When the carrier expects to deliver.</summary>
    public required DateOnly EstimatedDelivery { get; init; }
    /// <summary>When the parcel was delivered. Present only when it was.</summary>
    public DateTimeOffset? DeliveredAt { get; init; }
}

/// <summary>A shipment to create for an order.</summary>
public sealed class CreateShipmentRequest
{
    /// <summary>The order to ship, from <c>OrdersController.List</c>. It must be paid and not shipped yet.</summary>
    public Guid OrderId { get; set; }
    /// <summary>The carrier: <c>Ups</c>, <c>Dhl</c>, <c>FedEx</c>, <c>RoyalMail</c> or <c>CanadaPost</c>.</summary>
    public string Carrier { get; set; } = "Ups";
    /// <summary>The expected delivery date. Defaults from the order's shipping speed.</summary>
    public DateOnly? EstimatedDelivery { get; set; }
}
