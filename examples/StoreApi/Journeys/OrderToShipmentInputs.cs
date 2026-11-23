namespace StoreApi;

/// <summary>The inputs of <see cref="OrderToShipmentJourney"/>. The defaults order one jacket for Mia, a seeded customer.</summary>
public sealed class OrderToShipmentInputs
{
    /// <summary>The customer placing the order.</summary>
    public Guid CustomerId { get; set; } = Guid.Parse(DemoData.MiaId);

    /// <summary>The SKU to order. It must be active and in stock.</summary>
    public string Sku { get; set; } = DemoData.JacketSku;

    /// <summary>How many units to order, from 1 to 20.</summary>
    public int Quantity { get; set; } = 1;

    /// <summary>How fast the parcel travels: Standard, Express or Next day.</summary>
    public string ShippingSpeed { get; set; } = "Express";

    /// <summary>The carrier that collects the parcel: Ups, Dhl, FedEx, RoyalMail or CanadaPost.</summary>
    public string Carrier { get; set; } = "Dhl";

    /// <summary>The customer's email, where the order and shipping notices go.</summary>
    public string CustomerEmail { get; set; } = "mia.customer@acme.dev";
}
