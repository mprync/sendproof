namespace StoreApi;

// Persistence records. They are never returned by the API: Endpoints/Mapping.cs turns them into the documented contracts.

/// <summary>A person who can sign in to the demo.</summary>
public sealed class DemoUser
{
    /// <summary>Numeric key.</summary>
    public int Id { get; set; }
    /// <summary>Lower-case sign-in email address.</summary>
    public required string Email { get; set; }
    /// <summary>Display name.</summary>
    public required string Name { get; set; }
    /// <summary>The single role granted to the user: <c>admin</c>, <c>support</c>, <c>warehouse</c> or <c>customer</c>.</summary>
    public required string Role { get; set; }
    /// <summary>Job title shown in the user directory.</summary>
    public string? JobTitle { get; set; }
    /// <summary>Whether the user may sign in.</summary>
    public bool IsActive { get; set; } = true;
    /// <summary>ASP.NET Core Identity password hash.</summary>
    public required string PasswordHash { get; set; }
}

/// <summary>A product category.</summary>
public sealed class CategoryRecord
{
    /// <summary>Unique ID.</summary>
    public Guid Id { get; set; }
    /// <summary>URL-safe name, such as <c>running-shoes</c>.</summary>
    public required string Slug { get; set; }
    /// <summary>Display name.</summary>
    public required string Name { get; set; }
    /// <summary>What the category holds.</summary>
    public string? Description { get; set; }
    /// <summary>The parent category, or <c>null</c> for a top-level one.</summary>
    public Guid? ParentId { get; set; }
}

/// <summary>A product a shopper can buy, before its variants.</summary>
public sealed class ProductRecord
{
    /// <summary>Unique ID.</summary>
    public Guid Id { get; set; }
    /// <summary>URL-safe name.</summary>
    public required string Slug { get; set; }
    /// <summary>Display name.</summary>
    public required string Name { get; set; }
    /// <summary>The maker.</summary>
    public required string Brand { get; set; }
    /// <summary>Markdown description.</summary>
    public required string Description { get; set; }
    /// <summary>The category the product belongs to.</summary>
    public Guid CategoryId { get; set; }
    /// <summary>Whether the product can be bought.</summary>
    public ProductStatus Status { get; set; }
    /// <summary>Comma-separated tags.</summary>
    public string? Tags { get; set; }
    /// <summary>Weight in grams.</summary>
    public int WeightGrams { get; set; }
    /// <summary>Width in centimetres.</summary>
    public decimal WidthCm { get; set; }
    /// <summary>Height in centimetres.</summary>
    public decimal HeightCm { get; set; }
    /// <summary>Depth in centimetres.</summary>
    public decimal DepthCm { get; set; }
    /// <summary>The average review rating from 1 to 5.</summary>
    public double RatingAverage { get; set; }
    /// <summary>How many reviews the product has.</summary>
    public int ReviewCount { get; set; }
    /// <summary>When the product was created.</summary>
    public DateTimeOffset CreatedAt { get; set; }
    /// <summary>When the product last changed.</summary>
    public DateTimeOffset UpdatedAt { get; set; }
}

/// <summary>One purchasable version of a product, identified by its SKU.</summary>
public sealed class VariantRecord
{
    /// <summary>Unique ID.</summary>
    public Guid Id { get; set; }
    /// <summary>The product it belongs to.</summary>
    public Guid ProductId { get; set; }
    /// <summary>The stock-keeping unit, such as <c>TRL-PRO-BLK-42</c>.</summary>
    public required string Sku { get; set; }
    /// <summary>The option summary, such as <c>Black / 42 mm</c>.</summary>
    public required string Name { get; set; }
    /// <summary>The colour option, if any.</summary>
    public string? Color { get; set; }
    /// <summary>The size option, if any.</summary>
    public string? Size { get; set; }
    /// <summary>The barcode (EAN-13).</summary>
    public string? Barcode { get; set; }
}

/// <summary>The price of a variant in one currency.</summary>
public sealed class PriceRecord
{
    /// <summary>Unique ID.</summary>
    public Guid Id { get; set; }
    /// <summary>The variant priced.</summary>
    public Guid VariantId { get; set; }
    /// <summary>The currency of the price.</summary>
    public Currency Currency { get; set; }
    /// <summary>The unit price, tax included.</summary>
    public decimal Amount { get; set; }
}

/// <summary>How much of a variant a warehouse holds.</summary>
public sealed class StockRecord
{
    /// <summary>Unique ID.</summary>
    public Guid Id { get; set; }
    /// <summary>The variant counted.</summary>
    public Guid VariantId { get; set; }
    /// <summary>The warehouse code, such as <c>DUB-01</c>.</summary>
    public required string Warehouse { get; set; }
    /// <summary>Units on the shelf, including those reserved.</summary>
    public int OnHand { get; set; }
    /// <summary>Units held for carts and orders that have not shipped.</summary>
    public int Reserved { get; set; }
    /// <summary>The level at which the warehouse reorders.</summary>
    public int ReorderPoint { get; set; }
    /// <summary>When the level last changed.</summary>
    public DateTimeOffset UpdatedAt { get; set; }
}

/// <summary>A change to a stock level.</summary>
public sealed class StockMovementRecord
{
    /// <summary>Unique ID.</summary>
    public Guid Id { get; set; }
    /// <summary>The variant moved.</summary>
    public Guid VariantId { get; set; }
    /// <summary>Units added (positive) or removed (negative).</summary>
    public int Delta { get; set; }
    /// <summary>Why it moved.</summary>
    public StockReason Reason { get; set; }
    /// <summary>The order or delivery behind the move.</summary>
    public string? Reference { get; set; }
    /// <summary>Email of who or what moved it.</summary>
    public required string Actor { get; set; }
    /// <summary>When it moved.</summary>
    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>Stock held for a cart or an order.</summary>
public sealed class ReservationRecord
{
    /// <summary>Unique ID.</summary>
    public Guid Id { get; set; }
    /// <summary>The variant held.</summary>
    public Guid VariantId { get; set; }
    /// <summary>Units held.</summary>
    public int Quantity { get; set; }
    /// <summary>The order the stock is committed to, once it is placed.</summary>
    public Guid? OrderId { get; set; }
    /// <summary>The customer whose cart holds the stock.</summary>
    public Guid? CustomerId { get; set; }
    /// <summary>Whether it still holds stock.</summary>
    public ReservationStatus Status { get; set; }
    /// <summary>When a held reservation expires.</summary>
    public DateTimeOffset ExpiresAt { get; set; }
    /// <summary>When the reservation was made.</summary>
    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>A shopper's profile.</summary>
public sealed class CustomerRecord
{
    /// <summary>Unique ID.</summary>
    public Guid Id { get; set; }
    /// <summary>Email address; also how the customer signs in when they have a user.</summary>
    public required string Email { get; set; }
    /// <summary>Given name.</summary>
    public required string FirstName { get; set; }
    /// <summary>Family name.</summary>
    public required string LastName { get; set; }
    /// <summary>Phone number in international format.</summary>
    public string? Phone { get; set; }
    /// <summary>The currency the customer shops in.</summary>
    public Currency PreferredCurrency { get; set; }
    /// <summary>Loyalty tier.</summary>
    public CustomerTier Tier { get; set; }
    /// <summary>Whether the customer agreed to marketing email.</summary>
    public bool MarketingOptIn { get; set; }
    /// <summary>When the customer registered.</summary>
    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>An address saved on a customer.</summary>
public sealed class AddressRecord
{
    /// <summary>Unique ID.</summary>
    public Guid Id { get; set; }
    /// <summary>The customer it belongs to.</summary>
    public Guid CustomerId { get; set; }
    /// <summary>Shipping or billing.</summary>
    public AddressKind Kind { get; set; }
    /// <summary>A label such as <c>Home</c> or <c>Office</c>.</summary>
    public required string Label { get; set; }
    /// <summary>The recipient.</summary>
    public required string Recipient { get; set; }
    /// <summary>First address line.</summary>
    public required string Line1 { get; set; }
    /// <summary>Second address line.</summary>
    public string? Line2 { get; set; }
    /// <summary>City or town.</summary>
    public required string City { get; set; }
    /// <summary>State, county or province.</summary>
    public string? Region { get; set; }
    /// <summary>Postal code.</summary>
    public required string PostalCode { get; set; }
    /// <summary>ISO 3166-1 alpha-2 country.</summary>
    public required string Country { get; set; }
    /// <summary>Whether this is the customer's default for its kind.</summary>
    public bool IsDefault { get; set; }
}

/// <summary>A customer's open cart. One customer has one cart.</summary>
public sealed class CartRecord
{
    /// <summary>Unique ID.</summary>
    public Guid Id { get; set; }
    /// <summary>The owner.</summary>
    public Guid CustomerId { get; set; }
    /// <summary>The currency the cart is priced in.</summary>
    public Currency Currency { get; set; }
    /// <summary>A coupon applied to the cart.</summary>
    public string? CouponCode { get; set; }
    /// <summary>When the cart last changed.</summary>
    public DateTimeOffset UpdatedAt { get; set; }
}

/// <summary>A line of a cart.</summary>
public sealed class CartItemRecord
{
    /// <summary>Unique ID.</summary>
    public Guid Id { get; set; }
    /// <summary>The cart it is in.</summary>
    public Guid CartId { get; set; }
    /// <summary>The variant wanted.</summary>
    public Guid VariantId { get; set; }
    /// <summary>How many.</summary>
    public int Quantity { get; set; }
}

/// <summary>A placed order.</summary>
public sealed class OrderRecord
{
    /// <summary>Unique ID.</summary>
    public Guid Id { get; set; }
    /// <summary>Human-friendly number such as <c>AS-2026-004512</c>.</summary>
    public required string Number { get; set; }
    /// <summary>The customer who ordered.</summary>
    public Guid CustomerId { get; set; }
    /// <summary>Where the order is in its life.</summary>
    public OrderStatus Status { get; set; }
    /// <summary>The currency of every amount on the order.</summary>
    public Currency Currency { get; set; }
    /// <summary>The sum of the lines.</summary>
    public decimal Subtotal { get; set; }
    /// <summary>What the coupon took off.</summary>
    public decimal Discount { get; set; }
    /// <summary>The shipping cost.</summary>
    public decimal ShippingCost { get; set; }
    /// <summary>The tax included in the total.</summary>
    public decimal Tax { get; set; }
    /// <summary>What the customer pays.</summary>
    public decimal Total { get; set; }
    /// <summary>The coupon used.</summary>
    public string? CouponCode { get; set; }
    /// <summary>How fast it ships.</summary>
    public ShippingSpeed ShippingSpeed { get; set; }
    /// <summary>The recipient.</summary>
    public required string ShipToName { get; set; }
    /// <summary>First address line.</summary>
    public required string ShipToLine1 { get; set; }
    /// <summary>Second address line.</summary>
    public string? ShipToLine2 { get; set; }
    /// <summary>City or town.</summary>
    public required string ShipToCity { get; set; }
    /// <summary>State, county or province.</summary>
    public string? ShipToRegion { get; set; }
    /// <summary>Postal code.</summary>
    public required string ShipToPostalCode { get; set; }
    /// <summary>ISO 3166-1 alpha-2 country.</summary>
    public required string ShipToCountry { get; set; }
    /// <summary>A note from the customer, such as a gift message.</summary>
    public string? Note { get; set; }
    /// <summary>Why the order was cancelled.</summary>
    public string? CancelReason { get; set; }
    /// <summary>Email of who placed the order.</summary>
    public required string PlacedBy { get; set; }
    /// <summary>The caller's idempotency key.</summary>
    public string? IdempotencyKey { get; set; }
    /// <summary>Hash of the request body, to tell a replay from a clash.</summary>
    public string? RequestHash { get; set; }
    /// <summary>When the order was placed.</summary>
    public DateTimeOffset PlacedAt { get; set; }
    /// <summary>When the order last changed.</summary>
    public DateTimeOffset UpdatedAt { get; set; }
}

/// <summary>A line of an order, with the price and name it had when the order was placed.</summary>
public sealed class OrderLineRecord
{
    /// <summary>Unique ID.</summary>
    public Guid Id { get; set; }
    /// <summary>The order it is on.</summary>
    public Guid OrderId { get; set; }
    /// <summary>The variant bought.</summary>
    public Guid VariantId { get; set; }
    /// <summary>The SKU at the time.</summary>
    public required string Sku { get; set; }
    /// <summary>The product and option names at the time.</summary>
    public required string Name { get; set; }
    /// <summary>How many.</summary>
    public int Quantity { get; set; }
    /// <summary>The unit price at the time.</summary>
    public decimal UnitPrice { get; set; }
    /// <summary>Quantity times the unit price.</summary>
    public decimal LineTotal { get; set; }
}

/// <summary>The payment taken for an order.</summary>
public sealed class PaymentRecord
{
    /// <summary>Unique ID.</summary>
    public Guid Id { get; set; }
    /// <summary>The order paid.</summary>
    public Guid OrderId { get; set; }
    /// <summary>How the customer paid.</summary>
    public PaymentMethodKind Method { get; set; }
    /// <summary>Where the payment is in its life.</summary>
    public PaymentStatus Status { get; set; }
    /// <summary>The amount charged.</summary>
    public decimal Amount { get; set; }
    /// <summary>The currency of the amount.</summary>
    public Currency Currency { get; set; }
    /// <summary>A display of the method, such as <c>Visa •••• 4242</c>.</summary>
    public required string MethodDisplay { get; set; }
    /// <summary>The payment provider's reference.</summary>
    public required string ProviderReference { get; set; }
    /// <summary>The part of the amount that was refunded.</summary>
    public decimal RefundedAmount { get; set; }
    /// <summary>Why the payment failed.</summary>
    public string? FailureReason { get; set; }
    /// <summary>When the payment was created.</summary>
    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>A refund of part or all of a payment.</summary>
public sealed class RefundRecord
{
    /// <summary>Unique ID.</summary>
    public Guid Id { get; set; }
    /// <summary>The payment refunded.</summary>
    public Guid PaymentId { get; set; }
    /// <summary>The amount refunded.</summary>
    public decimal Amount { get; set; }
    /// <summary>The currency of the amount.</summary>
    public Currency Currency { get; set; }
    /// <summary>Why it was refunded.</summary>
    public RefundReason Reason { get; set; }
    /// <summary>An explanation.</summary>
    public string? Note { get; set; }
    /// <summary>Email of who refunded.</summary>
    public required string CreatedBy { get; set; }
    /// <summary>When it was refunded.</summary>
    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>A parcel on its way to a customer.</summary>
public sealed class ShipmentRecord
{
    /// <summary>Unique ID.</summary>
    public Guid Id { get; set; }
    /// <summary>The order shipped.</summary>
    public Guid OrderId { get; set; }
    /// <summary>The carrier.</summary>
    public Carrier Carrier { get; set; }
    /// <summary>The carrier's tracking number.</summary>
    public required string TrackingNumber { get; set; }
    /// <summary>Where the parcel is.</summary>
    public ShipmentStatus Status { get; set; }
    /// <summary>The scans so far, as JSON.</summary>
    public required string EventsJson { get; set; }
    /// <summary>When the parcel was handed over.</summary>
    public DateTimeOffset ShippedAt { get; set; }
    /// <summary>When the carrier expects to deliver.</summary>
    public DateOnly EstimatedDelivery { get; set; }
    /// <summary>When the parcel was delivered.</summary>
    public DateTimeOffset? DeliveredAt { get; set; }
}

/// <summary>A discount code.</summary>
public sealed class CouponRecord
{
    /// <summary>Unique ID.</summary>
    public Guid Id { get; set; }
    /// <summary>The code a shopper types, such as <c>SPRING15</c>.</summary>
    public required string Code { get; set; }
    /// <summary>What it takes off.</summary>
    public CouponKind Kind { get; set; }
    /// <summary>The percentage taken off, for a percentage coupon.</summary>
    public int? PercentOff { get; set; }
    /// <summary>The amount taken off, for a fixed-amount coupon.</summary>
    public decimal? AmountOff { get; set; }
    /// <summary>The currency of the amount.</summary>
    public Currency? Currency { get; set; }
    /// <summary>The smallest subtotal the coupon applies to.</summary>
    public decimal? MinSubtotal { get; set; }
    /// <summary>How many times it may be used.</summary>
    public int? MaxRedemptions { get; set; }
    /// <summary>How many times it was used.</summary>
    public int Redeemed { get; set; }
    /// <summary>The last day it works.</summary>
    public DateOnly? ExpiresOn { get; set; }
    /// <summary>Whether it can be used.</summary>
    public bool IsActive { get; set; } = true;
    /// <summary>What the coupon is for.</summary>
    public required string Description { get; set; }
}

/// <summary>A local record of a change to an order or another business object.</summary>
public sealed class AuditEventRecord
{
    /// <summary>Unique ID.</summary>
    public Guid Id { get; set; }
    /// <summary>Kind of object changed, e.g. <c>Order</c>.</summary>
    public required string EntityType { get; set; }
    /// <summary>ID of the changed object.</summary>
    public required string EntityId { get; set; }
    /// <summary>What happened, e.g. <c>Order.Placed</c>.</summary>
    public required string Action { get; set; }
    /// <summary>Email of the actor.</summary>
    public required string Actor { get; set; }
    /// <summary>When it happened.</summary>
    public DateTimeOffset CreatedAt { get; set; }
}
