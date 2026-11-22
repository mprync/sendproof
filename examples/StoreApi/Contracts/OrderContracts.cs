using System.ComponentModel.DataAnnotations;
using System.Text.Json.Serialization;

namespace StoreApi;

/// <summary>
/// How the customer pays. The <c>type</c> property selects the variant: <c>Card</c>, <c>BankTransfer</c> or <c>GiftCard</c>.
/// </summary>
[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]
[JsonDerivedType(typeof(CardPayment), "Card")]
[JsonDerivedType(typeof(BankTransferPayment), "BankTransfer")]
[JsonDerivedType(typeof(GiftCardPayment), "GiftCard")]
public abstract class PaymentMethod
{
    /// <summary>A printable description of the method, used on the receipt.</summary>
    internal abstract string Display { get; }
    /// <summary>The kind of method.</summary>
    internal abstract PaymentMethodKind Kind { get; }
}

/// <summary>A credit or debit card, identified by a token from the payment form.</summary>
public sealed class CardPayment : PaymentMethod
{
    /// <summary>The card token, such as <c>tok_visa_4242</c>. Tokens ending in <c>_0002</c> are declined.</summary>
    [Required, RegularExpression("^tok_[a-z]+_[0-9]{4}$")] public string Token { get; set; } = "";
    /// <summary>The card network.</summary>
    public string Brand { get; set; } = "Visa";
    /// <summary>The name on the card.</summary>
    [MaxLength(60)] public string? HolderName { get; set; }
    /// <inheritdoc />
    internal override string Display => $"{Brand} •••• {Token[^4..]}";
    /// <inheritdoc />
    internal override PaymentMethodKind Kind => PaymentMethodKind.Card;
}

/// <summary>A bank transfer the customer makes after ordering, matched to the order by its number.</summary>
public sealed class BankTransferPayment : PaymentMethod
{
    /// <summary>The name of the customer's bank.</summary>
    [Required, MaxLength(60)] public string BankName { get; set; } = "";
    /// <summary>The name on the sending account.</summary>
    [Required, MaxLength(60)] public string AccountHolder { get; set; } = "";
    /// <inheritdoc />
    internal override string Display => $"Bank transfer from {BankName}";
    /// <inheritdoc />
    internal override PaymentMethodKind Kind => PaymentMethodKind.BankTransfer;
}

/// <summary>A prepaid Acme gift card.</summary>
public sealed class GiftCardPayment : PaymentMethod
{
    /// <summary>The gift card code: four groups of four letters or digits, such as <c>GIFT-7K2M-9QXA-4D8P</c>.</summary>
    [Required, RegularExpression("^GIFT(-[A-Z0-9]{4}){3}$")] public string Code { get; set; } = "";
    /// <inheritdoc />
    internal override string Display => $"Gift card {Code[..9]}…";
    /// <inheritdoc />
    internal override PaymentMethodKind Kind => PaymentMethodKind.GiftCard;
}

/// <summary>One line of an order to place.</summary>
public sealed class OrderLineRequest
{
    /// <summary>The SKU, from a product's variants or <c>StockController.List</c>.</summary>
    [Required, RegularExpression("^[A-Z0-9-]{6,24}$")] public string Sku { get; set; } = "";
    /// <summary>How many.</summary>
    [Range(1, 20)] public int Quantity { get; set; } = 1;
}

/// <summary>An order to place.</summary>
public sealed class PlaceOrderRequest
{
    /// <summary>The customer ordering, from <c>CustomersController.List</c>. Customers can only order for themselves.</summary>
    public Guid CustomerId { get; set; }
    /// <summary>The lines. At least one, at most 20.</summary>
    [Required, MinLength(1), MaxLength(20)] public OrderLineRequest[] Items { get; set; } = [];
    /// <summary>The currency to charge in. Every line is priced in it.</summary>
    public string Currency { get; set; } = "USD";
    /// <summary>Where to deliver.</summary>
    [Required] public Address ShippingAddress { get; set; } = new();
    /// <summary>How fast to deliver: <c>Standard</c>, <c>Express</c> or <c>Next day</c>.</summary>
    public string ShippingSpeed { get; set; } = "Standard";
    /// <summary>A coupon code, checked with <c>CouponsController.Check</c>.</summary>
    [MaxLength(30)] public string? CouponCode { get; set; }
    /// <summary>The ID of a price quote from <c>CartsController.Quote</c>. The order fails with 409 when the price has moved since.</summary>
    [MaxLength(40)] public string? QuoteId { get; set; }
    /// <summary>How the customer pays.</summary>
    [Required] public PaymentMethod? Payment { get; set; }
    /// <summary>A note for the warehouse or a gift message.</summary>
    [MaxLength(300)] public string? Note { get; set; }
}

/// <summary>A line of an order, with the name and price it had when the order was placed.</summary>
public sealed class OrderLine
{
    /// <summary>The line's ID.</summary>
    public required Guid Id { get; init; }
    /// <summary>The variant bought.</summary>
    public required VariantReference Variant { get; init; }
    /// <summary>How many.</summary>
    public required int Quantity { get; init; }
    /// <summary>The unit price at the time.</summary>
    public required Money UnitPrice { get; init; }
    /// <summary>Quantity times the unit price.</summary>
    public required Money LineTotal { get; init; }
}

/// <summary>A short description of a payment, embedded in orders.</summary>
public sealed class PaymentReference
{
    /// <summary>The payment's ID. Use it with the payment operations.</summary>
    public required Guid Id { get; init; }
    /// <summary>A display of the method, such as <c>Visa •••• 4242</c>.</summary>
    public required string Method { get; init; }
    /// <summary>Where the payment is.</summary>
    public required PaymentStatus Status { get; init; }
}

/// <summary>A short description of a shipment, embedded in orders.</summary>
public sealed class ShipmentReference
{
    /// <summary>The shipment's ID.</summary>
    public required Guid Id { get; init; }
    /// <summary>The carrier.</summary>
    public required Carrier Carrier { get; init; }
    /// <summary>The tracking number.</summary>
    public required string TrackingNumber { get; init; }
    /// <summary>Where the parcel is.</summary>
    public required ShipmentStatus Status { get; init; }
}

/// <summary>An order as listed.</summary>
public sealed class OrderSummary
{
    /// <summary>The order's ID.</summary>
    public required Guid Id { get; init; }
    /// <summary>The human-friendly number, such as <c>AS-2026-004512</c>.</summary>
    public required string Number { get; init; }
    /// <summary>Where the order is in its life.</summary>
    public required OrderStatus Status { get; init; }
    /// <summary>The customer.</summary>
    public required CustomerReference Customer { get; init; }
    /// <summary>What the customer pays.</summary>
    public required Money Total { get; init; }
    /// <summary>How many units the order holds.</summary>
    public required int ItemCount { get; init; }
    /// <summary>When the order was placed.</summary>
    public required DateTimeOffset PlacedAt { get; init; }
}

/// <summary>An order with its lines, totals, payment and shipments.</summary>
public sealed class Order
{
    /// <summary>The order's ID.</summary>
    public required Guid Id { get; init; }
    /// <summary>The human-friendly number, such as <c>AS-2026-004512</c>.</summary>
    public required string Number { get; init; }
    /// <summary>Where the order is in its life.</summary>
    public required OrderStatus Status { get; init; }
    /// <summary>The customer.</summary>
    public required CustomerReference Customer { get; init; }
    /// <summary>The lines, as they were when the order was placed.</summary>
    public required IReadOnlyList<OrderLine> Lines { get; init; }
    /// <summary>The totals.</summary>
    public required OrderTotals Totals { get; init; }
    /// <summary>The coupon used, if any.</summary>
    public string? CouponCode { get; init; }
    /// <summary>How fast the order ships.</summary>
    public required ShippingSpeed ShippingSpeed { get; init; }
    /// <summary>Where the order is delivered.</summary>
    public required Address ShippingAddress { get; init; }
    /// <summary>The payment taken. Absent while the order has none.</summary>
    public PaymentReference? Payment { get; init; }
    /// <summary>The shipments, oldest first.</summary>
    public required IReadOnlyList<ShipmentReference> Shipments { get; init; }
    /// <summary>A note from the customer.</summary>
    public string? Note { get; init; }
    /// <summary>Why the order was cancelled. Present only when it was.</summary>
    public string? CancelReason { get; init; }
    /// <summary>Who placed the order.</summary>
    public required ActorReference PlacedBy { get; init; }
    /// <summary>When the order was placed.</summary>
    public required DateTimeOffset PlacedAt { get; init; }
    /// <summary>When the order last changed.</summary>
    public required DateTimeOffset UpdatedAt { get; init; }
}

/// <summary>An optional reason for cancelling an order.</summary>
public sealed class CancelOrderRequest
{
    /// <summary>Why the order is cancelled. Kept on the order and in its history.</summary>
    [MaxLength(200)] public string? Reason { get; set; }
}

/// <summary>One event in an order's history, kept in MongoDB.</summary>
public sealed class OrderEvent
{
    /// <summary>The kind of event, such as <c>Order.Placed</c> or <c>Shipment.Created</c>.</summary>
    public required string Type { get; init; }
    /// <summary>When it happened.</summary>
    public required DateTimeOffset At { get; init; }
    /// <summary>Who or what caused it.</summary>
    public required ActorReference Actor { get; init; }
    /// <summary>The order's status after the event.</summary>
    public required string Status { get; init; }
    /// <summary>A sentence about the event.</summary>
    public required string Summary { get; init; }
}

/// <summary>An order's history, kept as one document in MongoDB.</summary>
public sealed class OrderTimeline
{
    /// <summary>The order's ID.</summary>
    public required Guid OrderId { get; init; }
    /// <summary>The order's number.</summary>
    public required string Number { get; init; }
    /// <summary>The events, oldest first.</summary>
    public required IReadOnlyList<OrderEvent> Events { get; init; }
    /// <summary>When the document last changed.</summary>
    public required DateTimeOffset UpdatedAt { get; init; }
}
