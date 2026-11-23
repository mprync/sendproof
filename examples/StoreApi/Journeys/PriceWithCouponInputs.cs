namespace StoreApi;

/// <summary>The inputs of <see cref="PriceWithCouponJourney"/>. The defaults price one jacket in euro with the welcome coupon.</summary>
public sealed class PriceWithCouponInputs
{
    /// <summary>The coupon to check, price with and redeem.</summary>
    public string CouponCode { get; set; } = "ACME10";

    /// <summary>The SKU to price.</summary>
    public string Sku { get; set; } = DemoData.JacketSku;

    /// <summary>How many units, from 1 to 20.</summary>
    public int Quantity { get; set; } = 2;
}
