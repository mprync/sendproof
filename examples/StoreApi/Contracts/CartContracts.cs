using System.ComponentModel.DataAnnotations;

namespace StoreApi;

/// <summary>What a basket costs, line by line and in total.</summary>
public sealed class OrderTotals
{
    /// <summary>The sum of the lines.</summary>
    public required Money Subtotal { get; init; }
    /// <summary>What the coupon takes off. Zero without a coupon.</summary>
    public required Money Discount { get; init; }
    /// <summary>The shipping cost.</summary>
    public required Money Shipping { get; init; }
    /// <summary>The tax included in the total.</summary>
    public required Money Tax { get; init; }
    /// <summary>What the customer pays.</summary>
    public required Money Total { get; init; }
}

/// <summary>A line of a cart.</summary>
public sealed class CartItem
{
    /// <summary>The line's ID.</summary>
    public required Guid Id { get; init; }
    /// <summary>The variant wanted.</summary>
    public required VariantReference Variant { get; init; }
    /// <summary>How many.</summary>
    public required int Quantity { get; init; }
    /// <summary>The unit price in the cart's currency.</summary>
    public required Money UnitPrice { get; init; }
    /// <summary>Quantity times the unit price.</summary>
    public required Money LineTotal { get; init; }
    /// <summary>The units available now. Less than the quantity means the line cannot be ordered yet.</summary>
    public required int Available { get; init; }
}

/// <summary>A customer's cart, priced.</summary>
public sealed class Cart
{
    /// <summary>The cart's ID.</summary>
    public required Guid Id { get; init; }
    /// <summary>The owner.</summary>
    public required CustomerReference Customer { get; init; }
    /// <summary>The currency the cart is priced in.</summary>
    public required Currency Currency { get; init; }
    /// <summary>The coupon applied, if any.</summary>
    public string? CouponCode { get; init; }
    /// <summary>The lines.</summary>
    public required IReadOnlyList<CartItem> Items { get; init; }
    /// <summary>The totals, with standard shipping.</summary>
    public required OrderTotals Totals { get; init; }
    /// <summary>When the cart last changed.</summary>
    public required DateTimeOffset UpdatedAt { get; init; }
}

/// <summary>A variant to put in a cart.</summary>
public sealed class AddCartItemRequest
{
    /// <summary>The SKU, from <c>StockController.List</c> or a product's variants.</summary>
    [Required, RegularExpression("^[A-Z0-9-]{6,24}$")] public string Sku { get; set; } = "";
    /// <summary>How many.</summary>
    [Range(1, 20)] public int Quantity { get; set; } = 1;
}

/// <summary>The new quantity of a cart line.</summary>
public sealed class UpdateCartItemRequest
{
    /// <summary>How many. Use <c>CartsController.RemoveItem</c> to remove the line.</summary>
    [Range(1, 20)] public int Quantity { get; set; } = 1;
}

/// <summary>One line of a price quote request.</summary>
public sealed class QuoteLineRequest
{
    /// <summary>The SKU to price.</summary>
    [Required, RegularExpression("^[A-Z0-9-]{6,24}$")] public string Sku { get; set; } = "";
    /// <summary>How many.</summary>
    [Range(1, 20)] public int Quantity { get; set; } = 1;
}

/// <summary>What to price.</summary>
public sealed class PriceQuoteRequest
{
    /// <summary>The lines to price.</summary>
    [Required, MinLength(1), MaxLength(20)] public QuoteLineRequest[] Items { get; set; } = [];
    /// <summary>The currency to price in.</summary>
    public string Currency { get; set; } = "USD";
    /// <summary>How fast the order would ship.</summary>
    public string ShippingSpeed { get; set; } = "Standard";
    /// <summary>A coupon to apply.</summary>
    [MaxLength(30)] public string? CouponCode { get; set; }
    /// <summary>The country the order ships to, which decides the tax.</summary>
    [RegularExpression("^[A-Z]{2}$")] public string Country { get; set; } = "US";
}

/// <summary>A priced line of a quote.</summary>
public sealed class QuoteLine
{
    /// <summary>The variant priced.</summary>
    public required VariantReference Variant { get; init; }
    /// <summary>How many.</summary>
    public required int Quantity { get; init; }
    /// <summary>The unit price.</summary>
    public required Money UnitPrice { get; init; }
    /// <summary>Quantity times the unit price.</summary>
    public required Money LineTotal { get; init; }
}

/// <summary>A price held for 15 minutes. Pass its ID to <c>OrdersController.Place</c> to be charged exactly this.</summary>
public sealed class PriceQuote
{
    /// <summary>The quote's ID.</summary>
    public required string Id { get; init; }
    /// <summary>The priced lines.</summary>
    public required IReadOnlyList<QuoteLine> Lines { get; init; }
    /// <summary>The totals.</summary>
    public required OrderTotals Totals { get; init; }
    /// <summary>When the quote stops being honoured.</summary>
    public required DateTimeOffset ValidUntil { get; init; }
}
