using System.ComponentModel;
using System.Text.Json.Serialization;

namespace StoreApi;

// Every enum is a documented string enum. The Description attributes become the `x-enum-descriptions` hints the workbench
// shows beside each value, and the XML comments become the schema descriptions.

/// <summary>ISO 4217 currencies the Acme Store sells in.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<Currency>))]
public enum Currency
{
    /// <summary>US dollar.</summary>
    [Description("US dollar")] USD,
    /// <summary>Euro.</summary>
    [Description("Euro")] EUR,
    /// <summary>Pound sterling.</summary>
    [Description("Pound sterling")] GBP,
    /// <summary>Canadian dollar.</summary>
    [Description("Canadian dollar")] CAD,
    /// <summary>Australian dollar.</summary>
    [Description("Australian dollar")] AUD,
    /// <summary>Swedish krona.</summary>
    [Description("Swedish krona")] SEK,
    /// <summary>Swiss franc.</summary>
    [Description("Swiss franc")] CHF,
    /// <summary>Japanese yen, which has no minor unit.</summary>
    [Description("Japanese yen")] JPY
}

/// <summary>Whether a product can be bought.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<ProductStatus>))]
public enum ProductStatus
{
    /// <summary>Being prepared; not visible in the storefront.</summary>
    [Description("Being prepared; hidden from shoppers.")] Draft,
    /// <summary>On sale.</summary>
    [Description("On sale in the storefront.")] Active,
    /// <summary>Withdrawn from sale. Existing orders keep it.</summary>
    [Description("Withdrawn from sale; past orders keep it.")] Archived
}

/// <summary>Where an order is in its life.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<OrderStatus>))]
public enum OrderStatus
{
    /// <summary>Placed, waiting for the payment to be captured.</summary>
    [Description("Placed; waiting for the payment to be captured.")] Pending,
    /// <summary>Payment captured.</summary>
    [Description("Payment captured; ready for the warehouse.")] Paid,
    /// <summary>Being picked and packed.</summary>
    [Description("Being picked and packed.")] Processing,
    /// <summary>Handed to the carrier.</summary>
    [Description("With the carrier.")] Shipped,
    /// <summary>Delivered to the customer.</summary>
    [Description("Delivered to the customer.")] Delivered,
    /// <summary>Cancelled before it shipped.</summary>
    [Description("Cancelled before it shipped; stock released.")] Cancelled,
    /// <summary>Fully refunded after delivery.</summary>
    [Description("Fully refunded.")] Refunded
}

/// <summary>Where a payment is in its life.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<PaymentStatus>))]
public enum PaymentStatus
{
    /// <summary>The funds are held but not yet taken.</summary>
    [Description("Funds are held on the customer's payment method.")] Authorized,
    /// <summary>The funds were taken.</summary>
    [Description("Funds were taken.")] Captured,
    /// <summary>The payment method was declined.</summary>
    [Description("The payment method was declined.")] Failed,
    /// <summary>Part of the amount was refunded.</summary>
    [Description("Part of the amount was refunded.")] PartiallyRefunded,
    /// <summary>The whole amount was refunded.</summary>
    [Description("The whole amount was refunded.")] Refunded
}

/// <summary>How the customer pays. Also the discriminator of the payment method union.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<PaymentMethodKind>))]
public enum PaymentMethodKind
{
    /// <summary>A credit or debit card.</summary>
    [Description("A credit or debit card.")] Card,
    /// <summary>A bank transfer.</summary>
    [Description("A bank transfer, matched to the order by its reference.")] BankTransfer,
    /// <summary>A gift card.</summary>
    [Description("A prepaid Acme gift card.")] GiftCard
}

/// <summary>The card network.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<CardBrand>))]
public enum CardBrand
{
    /// <summary>Visa.</summary>
    [Description("Visa")] Visa,
    /// <summary>Mastercard.</summary>
    [Description("Mastercard")] Mastercard,
    /// <summary>American Express.</summary>
    [Description("American Express")] Amex
}

/// <summary>How quickly an order is delivered.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<ShippingSpeed>))]
public enum ShippingSpeed
{
    /// <summary>Delivered in 3 to 5 working days.</summary>
    [Description("3 to 5 working days.")] Standard,
    /// <summary>Delivered in 1 to 2 working days.</summary>
    [Description("1 to 2 working days.")] Express,
    /// <summary>Delivered the next working day when ordered before 2 pm.</summary>
    [Description("Next working day, if ordered before 2 pm.")] [JsonStringEnumMemberName("Next day")] NextDay
}

/// <summary>The carrier that moves a shipment.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<Carrier>))]
public enum Carrier
{
    /// <summary>UPS.</summary>
    [Description("UPS")] Ups,
    /// <summary>DHL Express.</summary>
    [Description("DHL Express")] Dhl,
    /// <summary>FedEx.</summary>
    [Description("FedEx")] FedEx,
    /// <summary>Royal Mail.</summary>
    [Description("Royal Mail")] RoyalMail,
    /// <summary>Canada Post.</summary>
    [Description("Canada Post")] CanadaPost
}

/// <summary>Where a shipment is on its way.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<ShipmentStatus>))]
public enum ShipmentStatus
{
    /// <summary>The label exists; the parcel is not yet scanned.</summary>
    [Description("Label created; waiting for the carrier's first scan.")] LabelCreated,
    /// <summary>Moving between depots.</summary>
    [Description("Moving between depots.")] InTransit,
    /// <summary>On the final vehicle.</summary>
    [Description("On the delivery vehicle today.")] OutForDelivery,
    /// <summary>Handed over.</summary>
    [Description("Handed over to the customer.")] Delivered,
    /// <summary>On its way back to the warehouse.</summary>
    [Description("On its way back to the warehouse.")] Returned
}

/// <summary>The kind of address a customer saves. </summary>
[JsonConverter(typeof(JsonStringEnumConverter<AddressKind>))]
public enum AddressKind
{
    /// <summary>Where orders are delivered.</summary>
    [Description("Where orders are delivered.")] Shipping,
    /// <summary>The address on the card statement.</summary>
    [Description("The address on the payment method.")] Billing
}

/// <summary>A customer's loyalty tier.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<CustomerTier>))]
public enum CustomerTier
{
    /// <summary>Every customer starts here.</summary>
    [Description("Every customer starts here.")] Standard,
    /// <summary>Free standard shipping.</summary>
    [Description("Free standard shipping.")] Plus,
    /// <summary>Free express shipping and early access to new products.</summary>
    [Description("Free express shipping and early access.")] Vip
}

/// <summary>Why stock moved.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<StockReason>))]
public enum StockReason
{
    /// <summary>A delivery from a supplier.</summary>
    [Description("A delivery from a supplier.")] Received,
    /// <summary>Sold through an order.</summary>
    [Description("Sold through an order.")] Sold,
    /// <summary>A returned item put back on the shelf.</summary>
    [Description("A returned item put back on the shelf.")] Returned,
    /// <summary>Counted and corrected.</summary>
    [Description("A stock count corrected the level.")] Adjustment,
    /// <summary>Written off.</summary>
    [Description("Written off as damaged.")] Damaged
}

/// <summary>Whether a reservation still holds stock.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<ReservationStatus>))]
public enum ReservationStatus
{
    /// <summary>Stock is held for a cart.</summary>
    [Description("Held for a cart; expires if the cart is abandoned.")] Held,
    /// <summary>The order was placed, so the stock left the shelf.</summary>
    [Description("The order was placed; the stock left the shelf.")] Committed,
    /// <summary>The cart expired or the order was cancelled.</summary>
    [Description("Returned to available stock.")] Released
}

/// <summary>Why a payment is refunded.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<RefundReason>))]
public enum RefundReason
{
    /// <summary>The item arrived damaged.</summary>
    [Description("The item arrived damaged.")] Damaged,
    /// <summary>The wrong item was sent.</summary>
    [Description("The wrong item was sent.")] [JsonStringEnumMemberName("Wrong item")] WrongItem,
    /// <summary>The item was not as described.</summary>
    [Description("The item was not as described.")] [JsonStringEnumMemberName("Not as described")] NotAsDescribed,
    /// <summary>The customer changed their mind.</summary>
    [Description("The customer changed their mind.")] [JsonStringEnumMemberName("Customer request")] CustomerRequest,
    /// <summary>Another reason, explained in the note.</summary>
    [Description("Another reason, explained in the note.")] Other
}

/// <summary>What a coupon takes off. Also the discriminator of the coupon union.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<CouponKind>))]
public enum CouponKind
{
    /// <summary>A percentage of the subtotal.</summary>
    [Description("A percentage of the subtotal.")] Percentage,
    /// <summary>A fixed amount off.</summary>
    [Description("A fixed amount off the subtotal.")] FixedAmount,
    /// <summary>Free shipping.</summary>
    [Description("Removes the shipping cost.")] FreeShipping
}

/// <summary>The roles a user can hold. A role is also the scope an operation lists.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<RoleName>))]
public enum RoleName
{
    /// <summary>Runs the store.</summary>
    [Description("Store admin: everything, including products, coupons and user roles.")] [JsonStringEnumMemberName("admin")] Admin,
    /// <summary>Helps customers.</summary>
    [Description("Support agent: customers, orders, refunds and reviews.")] [JsonStringEnumMemberName("support")] Support,
    /// <summary>Runs the warehouse.</summary>
    [Description("Warehouse: stock levels and shipments.")] [JsonStringEnumMemberName("warehouse")] Warehouse,
    /// <summary>A shopper.</summary>
    [Description("Customer: shops, places and follows their own orders.")] [JsonStringEnumMemberName("customer")] Customer
}

/// <summary>Sort values accepted by the list operations.</summary>
internal static class SortKeys
{
    /// <summary>Product list sort values.</summary>
    public static readonly string[] Products = ["name", "-name", "price", "-price", "createdAt", "-createdAt", "rating", "-rating"];
    /// <summary>Descriptions of the product sort values.</summary>
    public static readonly IReadOnlyDictionary<string, string> ProductDescriptions = new Dictionary<string, string>
    {
        ["name"] = "Name, A to Z.", ["-name"] = "Name, Z to A.", ["price"] = "Cheapest first.", ["-price"] = "Most expensive first.",
        ["createdAt"] = "Oldest first.", ["-createdAt"] = "Newest first.", ["rating"] = "Lowest rated first.", ["-rating"] = "Best rated first."
    };
    /// <summary>Stock list sort values.</summary>
    public static readonly string[] Stock = ["sku", "-sku", "available", "-available"];
    /// <summary>Customer list sort values.</summary>
    public static readonly string[] Customers = ["name", "-name", "createdAt", "-createdAt"];
    /// <summary>Order list sort values.</summary>
    public static readonly string[] Orders = ["placedAt", "-placedAt", "total", "-total", "number", "-number"];
    /// <summary>Payment list sort values.</summary>
    public static readonly string[] Payments = ["createdAt", "-createdAt", "amount", "-amount"];
    /// <summary>Shipment list sort values.</summary>
    public static readonly string[] Shipments = ["shippedAt", "-shippedAt"];
    /// <summary>Coupon list sort values.</summary>
    public static readonly string[] Coupons = ["code", "-code", "expiresOn", "-expiresOn"];
    /// <summary>User list sort values.</summary>
    public static readonly string[] Users = ["name", "-name", "email", "-email"];
}
