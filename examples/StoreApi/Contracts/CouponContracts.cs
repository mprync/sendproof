using System.ComponentModel.DataAnnotations;
using System.Text.Json.Serialization;

namespace StoreApi;

/// <summary>
/// A discount code. The <c>kind</c> property selects the variant: <c>Percentage</c>, <c>FixedAmount</c> or <c>FreeShipping</c>.
/// The same shape is the request body of <c>CouponsController.Create</c> and the response of the read operations.
/// </summary>
[JsonPolymorphic(TypeDiscriminatorPropertyName = "kind")]
[JsonDerivedType(typeof(PercentageCoupon), "Percentage")]
[JsonDerivedType(typeof(FixedAmountCoupon), "FixedAmount")]
[JsonDerivedType(typeof(FreeShippingCoupon), "FreeShipping")]
public abstract class Coupon
{
    /// <summary>The code a shopper types: 4 to 20 upper-case letters and digits, such as <c>SPRING15</c>.</summary>
    [Required, RegularExpression("^[A-Z0-9]{4,20}$")] public string Code { get; set; } = "";
    /// <summary>What the coupon is for, shown to staff.</summary>
    [Required, MaxLength(200)] public string Description { get; set; } = "";
    /// <summary>The smallest subtotal the coupon applies to, in the currency of the order. Optional.</summary>
    [Range(0, 1000000)] public decimal? MinSubtotal { get; set; }
    /// <summary>How many times the coupon may be used in all. Unlimited when absent.</summary>
    [Range(1, 1000000)] public int? MaxRedemptions { get; set; }
    /// <summary>The last day the coupon works. It never expires when absent.</summary>
    public DateOnly? ExpiresOn { get; set; }
    /// <summary>The coupon's ID. Set by the API; ignored when creating.</summary>
    public Guid? Id { get; set; }
    /// <summary>How many times it was used. Set by the API; ignored when creating.</summary>
    public int? Redeemed { get; set; }
    /// <summary>Whether the coupon can be used. Set by the API; ignored when creating.</summary>
    public bool? IsActive { get; set; }
}

/// <summary>A percentage off the subtotal.</summary>
public sealed class PercentageCoupon : Coupon
{
    /// <summary>The percentage taken off, from 1 to 90.</summary>
    [Range(1, 90)] public int PercentOff { get; set; }
}

/// <summary>A fixed amount off the subtotal.</summary>
public sealed class FixedAmountCoupon : Coupon
{
    /// <summary>The amount taken off.</summary>
    [Range(0.01, 100000)] public decimal AmountOff { get; set; }
    /// <summary>The currency of <c>amountOff</c>. The coupon only applies to orders in this currency.</summary>
    public string Currency { get; set; } = "USD";
}

/// <summary>Free shipping.</summary>
public sealed class FreeShippingCoupon : Coupon
{
}

/// <summary>Whether a coupon would apply to a basket, and what it would take off.</summary>
public sealed class CouponCheck
{
    /// <summary>The code that was checked.</summary>
    public required string Code { get; init; }
    /// <summary>Whether the coupon applies.</summary>
    public required bool Valid { get; init; }
    /// <summary>Why the coupon does not apply. Present only when it does not.</summary>
    public string? Reason { get; init; }
    /// <summary>What the coupon would take off. Present only when it applies.</summary>
    public Money? Discount { get; init; }
}

/// <summary>Redemptions to count against a coupon.</summary>
public sealed class RedeemCouponRequest
{
    /// <summary>How many redemptions to add, from 1 to 50. Several orders can be counted in one call.</summary>
    [Range(1, 50)] public int Count { get; set; } = 1;
    /// <summary>The order the redemption belongs to, kept for reconciliation.</summary>
    [MaxLength(30)] public string? OrderNumber { get; set; }
}

/// <summary>A coupon's redemption count after a redemption was counted.</summary>
public sealed class CouponRedemption
{
    /// <summary>The coupon's code.</summary>
    public required string Code { get; init; }
    /// <summary>How many times the coupon has been redeemed in all.</summary>
    public required int Redeemed { get; init; }
    /// <summary>How many redemptions are left. Absent when the coupon is unlimited.</summary>
    public int? Remaining { get; init; }
}
