namespace StoreApi;

/// <summary>
/// The store's pricing rules: currency conversion of the base catalogue, shipping, tax and coupons. Shared by the cart,
/// the quote and order placement so all three always agree.
/// </summary>
internal static class Pricing
{
    /// <summary>How many units of each currency one US dollar buys, used to derive the price lists from the base price.</summary>
    private static readonly Dictionary<Currency, decimal> PerUsd = new()
    {
        [Currency.USD] = 1m, [Currency.EUR] = 0.92m, [Currency.GBP] = 0.79m, [Currency.CAD] = 1.37m,
        [Currency.AUD] = 1.52m, [Currency.SEK] = 10.6m, [Currency.CHF] = 0.88m, [Currency.JPY] = 151m
    };

    /// <summary>How many units of a currency one US dollar buys.</summary>
    internal static decimal Rate(Currency currency) => PerUsd[currency];

    /// <summary>Converts a US-dollar base price to a currency and rounds it the way a shop does (ends in .99, or in tens of yen).</summary>
    internal static decimal Convert(decimal usd, Currency currency)
    {
        var value = usd * PerUsd[currency];
        if (currency == Currency.JPY) return Math.Round(value / 10m, 0, MidpointRounding.AwayFromZero) * 10m;
        if (usd < 10m) return decimal.Round(value, 2);
        return Math.Ceiling(value) - 0.01m;
    }

    /// <summary>The tax rate included in prices for a delivery country (VAT, GST or sales tax).</summary>
    internal static decimal TaxRate(string country) => country switch
    {
        "IE" => 0.23m, "DE" => 0.19m, "FR" => 0.20m, "NL" => 0.21m, "ES" => 0.21m, "GB" => 0.20m, "SE" => 0.25m,
        "CH" => 0.081m, "CA" => 0.13m, "AU" => 0.10m, "JP" => 0.10m, "US" => 0.08m, _ => 0.20m
    };

    /// <summary>The shipping cost of an order. Free standard shipping from 100 US dollars, and for Plus and VIP; free express for VIP.</summary>
    internal static decimal Shipping(ShippingSpeed speed, Currency currency, decimal subtotal, CustomerTier tier)
    {
        if (speed == ShippingSpeed.Standard && (tier != CustomerTier.Standard || subtotal >= Convert(100m, currency))) return 0m;
        if (speed == ShippingSpeed.Express && tier == CustomerTier.Vip) return 0m;
        return Convert(speed switch { ShippingSpeed.Standard => 5.99m, ShippingSpeed.Express => 12.99m, _ => 24.99m }, currency);
    }

    /// <summary>Why a coupon does not apply to a basket, or <c>null</c> when it does.</summary>
    internal static string? CouponProblem(CouponRecord coupon, decimal subtotal, Currency currency, DateOnly today)
    {
        if (!coupon.IsActive) return "The coupon is switched off.";
        if (coupon.ExpiresOn is { } expires && expires < today) return $"The coupon expired on {expires:d MMM yyyy}.";
        if (coupon.MaxRedemptions is { } max && coupon.Redeemed >= max) return "The coupon has been used the maximum number of times.";
        if (coupon.Kind == CouponKind.FixedAmount && coupon.Currency != currency) return $"The coupon only applies to orders in {coupon.Currency}.";
        if (coupon.MinSubtotal is { } min && subtotal < min) return $"The coupon needs a subtotal of at least {min:N2} {currency}.";
        return null;
    }

    /// <summary>What a coupon takes off a subtotal. Free shipping takes nothing off the subtotal.</summary>
    internal static decimal Discount(CouponRecord? coupon, decimal subtotal, Currency currency) => coupon switch
    {
        { Kind: CouponKind.Percentage, PercentOff: { } percent } => decimal.Round(subtotal * percent / 100m, EndpointSupport.Decimals(currency), MidpointRounding.ToZero),
        { Kind: CouponKind.FixedAmount, AmountOff: { } amount } => Math.Min(amount, subtotal),
        _ => 0m
    };

    /// <summary>Prices a basket: the subtotal of the lines, the discount, shipping and the tax included in the total.</summary>
    internal static OrderTotals Totals(decimal subtotal, CouponRecord? coupon, ShippingSpeed speed, Currency currency, CustomerTier tier, string country)
    {
        var discount = Discount(coupon, subtotal, currency);
        var shipping = coupon?.Kind == CouponKind.FreeShipping ? 0m : Shipping(speed, currency, subtotal, tier);
        var total = subtotal - discount + shipping;
        var rate = TaxRate(country);
        var tax = decimal.Round(total * rate / (1m + rate), EndpointSupport.Decimals(currency));
        return new OrderTotals
        {
            Subtotal = EndpointSupport.ToMoney(subtotal, currency), Discount = EndpointSupport.ToMoney(discount, currency),
            Shipping = EndpointSupport.ToMoney(shipping, currency), Tax = EndpointSupport.ToMoney(tax, currency),
            Total = EndpointSupport.ToMoney(total, currency)
        };
    }
}
