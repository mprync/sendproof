using System.Text.Json.Nodes;

namespace StoreApi;

/// <summary>Example bodies shown in the OpenAPI document. Dates are relative to today, so examples never go stale.</summary>
internal static class Examples
{
    private const string OrderId = "7d2e41a0-5c1b-4e8f-a3d2-6b0e19c49f13";
    private const string PaymentId = "5be0c7f1-93a4-4d6e-8f21-0c4a7d9e3b52";
    private const string ShipmentId = "2f6a91c3-4e08-4b7d-9a15-8d3c0e7b6f40";

    private static string Date(int days) => DateOnly.FromDateTime(DateTime.UtcNow.AddDays(days)).ToString("yyyy-MM-dd");
    private static string Instant(int days, int hour) =>
        new DateTimeOffset(DateTime.UtcNow.Date.AddDays(days).AddHours(hour), TimeSpan.Zero).ToString("yyyy-MM-ddTHH:mm:ssZ");

    private static JsonObject Money(decimal value, string currency) => new() { ["value"] = value, ["currency"] = currency };

    private static JsonObject Variant() => new() { ["id"] = "6e3b1d90-2a47-4c58-b0f9-71d5a2c84e13", ["sku"] = DemoData.JacketSku, ["name"] = "Northpeak Storm Shell Jacket, Black / M" };

    private static JsonObject Customer() => new() { ["id"] = DemoData.MiaId, ["name"] = "Mia Customer", ["email"] = "mia.customer@acme.dev" };

    private static JsonObject Address() => new()
    {
        ["recipient"] = "Mia Customer", ["line1"] = "14 Harcourt Street", ["line2"] = "Apartment 6", ["city"] = "Dublin", ["region"] = "Co. Dublin", ["postalCode"] = "D02 X285", ["country"] = "IE"
    };

    private static JsonObject Totals() => new()
    {
        ["subtotal"] = Money(188.99m, "EUR"), ["discount"] = Money(18.89m, "EUR"), ["shipping"] = Money(0, "EUR"), ["tax"] = Money(31.78m, "EUR"), ["total"] = Money(170.10m, "EUR")
    };

    private static JsonObject Line() => new()
    {
        ["id"] = "a3c5e7f9-1b2d-4f60-8a4c-5d7e9f1b3c20", ["variant"] = Variant(), ["quantity"] = 1, ["unitPrice"] = Money(188.99m, "EUR"), ["lineTotal"] = Money(188.99m, "EUR")
    };

    private static JsonObject Actor() => new() { ["email"] = "mia.customer@acme.dev", ["name"] = "Mia Customer" };

    private static JsonObject Review() => new()
    {
        ["id"] = "rv_3a9c04", ["rating"] = 5, ["title"] = "Survived a week of Atlantic rain",
        ["body"] = "Kept me dry on the Wicklow Way through three days of proper rain. Fits true to size and packs into its own pocket.",
        ["author"] = new JsonObject { ["name"] = "Aoife M.", ["verifiedPurchase"] = true }, ["helpfulVotes"] = 14,
        ["reply"] = new JsonObject { ["by"] = "Acme Store Support", ["text"] = "Thank you for the kind words!", ["at"] = Instant(-10, 9) },
        ["createdAt"] = Instant(-30, 18)
    };

    private static JsonObject Refund() => new()
    {
        ["id"] = "d8a1f3b5-6c27-4e90-a1d4-3b5f7c9e0a12", ["amount"] = Money(24.50m, "EUR"), ["reason"] = "Damaged", ["note"] = "Zip arrived broken.",
        ["createdBy"] = "pia.support@acme.dev", ["createdAt"] = Instant(-3, 11)
    };

    private static JsonObject StockLevel() => new()
    {
        ["variantId"] = "6e3b1d90-2a47-4c58-b0f9-71d5a2c84e13", ["sku"] = DemoData.JacketSku, ["name"] = "Northpeak Storm Shell Jacket, Black / M", ["warehouse"] = "DUB-01",
        ["onHand"] = 40, ["reserved"] = 2, ["available"] = 38, ["reorderPoint"] = 10, ["isLow"] = false, ["updatedAt"] = Instant(-2, 14)
    };

    private static JsonObject Shipment() => new()
    {
        ["id"] = ShipmentId, ["orderId"] = OrderId, ["orderNumber"] = "AS-2026-004512", ["carrier"] = "Dhl", ["trackingNumber"] = "JD014600004512493", ["status"] = "InTransit",
        ["events"] = new JsonArray(
            new JsonObject { ["at"] = Instant(-2, 16), ["location"] = "Dublin, IE", ["description"] = "Label created; the parcel is ready for collection." },
            new JsonObject { ["at"] = Instant(-2, 21), ["location"] = "Dublin, IE", ["description"] = "Picked up by the carrier." },
            new JsonObject { ["at"] = Instant(-1, 12), ["location"] = "Leipzig, DE", ["description"] = "Arrived at the sorting centre." }),
        ["shippedAt"] = Instant(-2, 16), ["estimatedDelivery"] = Date(2)
    };

    private static JsonObject Order() => new()
    {
        ["id"] = OrderId, ["number"] = "AS-2026-004512", ["status"] = "Shipped", ["customer"] = Customer(), ["lines"] = new JsonArray(Line()), ["totals"] = Totals(),
        ["couponCode"] = "ACME10", ["shippingSpeed"] = "Express", ["shippingAddress"] = Address(),
        ["payment"] = new JsonObject { ["id"] = PaymentId, ["method"] = "Visa •••• 4242", ["status"] = "Captured" },
        ["shipments"] = new JsonArray(new JsonObject { ["id"] = ShipmentId, ["carrier"] = "Dhl", ["trackingNumber"] = "JD014600004512493", ["status"] = "InTransit" }),
        ["note"] = "Please leave with the neighbour.", ["placedBy"] = Actor(), ["placedAt"] = Instant(-3, 10), ["updatedAt"] = Instant(-2, 16)
    };

    /// <summary>The example of a schema, if it has one.</summary>
    internal static JsonNode? For(Type type) => type.Name switch
    {
        nameof(LoginRequest) => new JsonObject { ["email"] = "ada.admin@acme.dev", ["password"] = DemoData.Password },
        nameof(Persona) => new JsonObject { ["email"] = "ada.admin@acme.dev", ["name"] = "Ada Admin", ["role"] = "admin" },
        nameof(Money) => Money(129.99m, "EUR"),
        nameof(Address) => Address(),
        nameof(OrderTotals) => Totals(),
        nameof(ActorReference) => Actor(),
        nameof(CustomerReference) => Customer(),
        nameof(VariantReference) => Variant(),
        nameof(Category) => new JsonObject
        {
            ["id"] = DemoData.JacketsCategoryId, ["slug"] = "jackets", ["name"] = "Jackets", ["description"] = "Shells, down jackets and mid-layers.",
            ["parentId"] = "ca7e0000-0000-4000-8000-0000000000aa", ["productCount"] = 6
        },
        nameof(CreateCategoryRequest) => new JsonObject { ["name"] = "Climbing", ["slug"] = "climbing", ["description"] = "Harnesses, ropes and protection." },
        nameof(ProductSummary) => new JsonObject
        {
            ["id"] = DemoData.JacketId, ["slug"] = "northpeak-storm-shell-jacket", ["name"] = "Northpeak Storm Shell Jacket", ["brand"] = "Northpeak",
            ["category"] = new JsonObject { ["id"] = DemoData.JacketsCategoryId, ["name"] = "Jackets" }, ["status"] = "Active", ["price"] = Money(188.99m, "EUR"),
            ["rating"] = 4.6, ["reviewCount"] = 9, ["inStock"] = true, ["tags"] = new JsonArray("waterproof", "bestseller", "shell")
        },
        nameof(Dimensions) => new JsonObject { ["widthCm"] = 32, ["heightCm"] = 14, ["depthCm"] = 10 },
        nameof(Variant) => new JsonObject
        {
            ["id"] = "6e3b1d90-2a47-4c58-b0f9-71d5a2c84e13", ["sku"] = DemoData.JacketSku, ["name"] = "Black / M", ["color"] = "Black", ["size"] = "M", ["barcode"] = "5391204718365",
            ["prices"] = new JsonArray(Money(204.99m, "USD"), Money(188.99m, "EUR"), Money(161.99m, "GBP"), Money(280.99m, "CAD"), Money(311.99m, "AUD"), Money(2170.99m, "SEK"), Money(180.99m, "CHF"), Money(28540, "JPY")),
            ["available"] = 38
        },
        nameof(Product) => new JsonObject
        {
            ["id"] = DemoData.JacketId, ["slug"] = "northpeak-storm-shell-jacket", ["name"] = "Northpeak Storm Shell Jacket", ["brand"] = "Northpeak",
            ["description"] = "A fully taped three-layer shell that keeps out a day of Atlantic rain and still packs into its own pocket.\n\n**Highlights**\n\n- Waterproof\n- Bestseller",
            ["category"] = new JsonObject { ["id"] = DemoData.JacketsCategoryId, ["name"] = "Jackets" }, ["status"] = "Active", ["tags"] = new JsonArray("waterproof", "bestseller"),
            ["weightGrams"] = 520, ["dimensions"] = new JsonObject { ["widthCm"] = 32, ["heightCm"] = 14, ["depthCm"] = 10 }, ["rating"] = 4.6, ["reviewCount"] = 9,
            ["variants"] = new JsonArray(new JsonObject
            {
                ["id"] = "6e3b1d90-2a47-4c58-b0f9-71d5a2c84e13", ["sku"] = DemoData.JacketSku, ["name"] = "Black / M", ["color"] = "Black", ["size"] = "M", ["barcode"] = "5391204718365",
                ["prices"] = new JsonArray(Money(204.99m, "USD"), Money(188.99m, "EUR")), ["available"] = 38
            }),
            ["createdAt"] = Instant(-300, 9), ["updatedAt"] = Instant(-12, 15)
        },
        nameof(CreateVariantRequest) => new JsonObject { ["sku"] = "NPK-WND-ORG-M", ["color"] = "Orange", ["size"] = "M", ["initialStock"] = 25 },
        nameof(CreateProductRequest) => new JsonObject
        {
            ["name"] = "Northpeak Trail Windbreaker", ["slug"] = "northpeak-trail-windbreaker", ["brand"] = "Northpeak",
            ["description"] = "A 110 g windbreaker for fast days.", ["categoryId"] = DemoData.JacketsCategoryId, ["price"] = 89, ["currency"] = "USD", ["weightGrams"] = 110,
            ["dimensions"] = new JsonObject { ["widthCm"] = 18, ["heightCm"] = 10, ["depthCm"] = 8 }, ["tags"] = new JsonArray("ultralight", "windproof"),
            ["variants"] = new JsonArray(
                new JsonObject { ["sku"] = "NPK-WND-ORG-M", ["color"] = "Orange", ["size"] = "M", ["initialStock"] = 25 },
                new JsonObject { ["sku"] = "NPK-WND-ORG-L", ["color"] = "Orange", ["size"] = "L", ["initialStock"] = 25 })
        },
        nameof(DimensionsInput) => new JsonObject { ["widthCm"] = 18, ["heightCm"] = 10, ["depthCm"] = 8 },
        nameof(UpdateProductRequest) => new JsonObject
        {
            ["name"] = "Northpeak Storm Shell Jacket", ["description"] = "A fully taped three-layer shell.", ["categoryId"] = DemoData.JacketsCategoryId,
            ["status"] = "Active", ["tags"] = new JsonArray("waterproof", "bestseller")
        },
        nameof(LegacyProductHit) => new JsonObject { ["id"] = DemoData.JacketId, ["name"] = "Northpeak Storm Shell Jacket", ["price"] = 204.99 },
        nameof(StockLevel) => StockLevel(),
        nameof(AdjustStockRequest) => new JsonObject { ["delta"] = 24, ["reason"] = "Received", ["reference"] = "PO-48213" },
        nameof(StockMovement) => new JsonObject
        {
            ["id"] = "b4d6f8a0-2c1e-4a39-9b57-6e8f0a2c4d71", ["delta"] = -1, ["reason"] = "Sold", ["reference"] = "AS-2026-004512", ["actor"] = "mia.customer@acme.dev", ["createdAt"] = Instant(-3, 10)
        },
        nameof(Reservation) => new JsonObject
        {
            ["id"] = "e1a3c5d7-9f0b-4b24-8c6e-1d3f5a7b9c02", ["variant"] = Variant(), ["quantity"] = 2, ["status"] = "Held", ["expiresAt"] = Instant(0, 14), ["createdAt"] = Instant(0, 13)
        },
        nameof(LegacyStockLevel) => new JsonObject { ["productId"] = DemoData.JacketId, ["quantity"] = 38 },
        nameof(Customer) => new JsonObject
        {
            ["id"] = DemoData.MiaId, ["email"] = "mia.customer@acme.dev", ["name"] = "Mia Customer", ["firstName"] = "Mia", ["lastName"] = "Customer", ["phone"] = "+353 87 412 9083", ["preferredCurrency"] = "EUR",
            ["tier"] = "Plus", ["marketingOptIn"] = true, ["orderCount"] = 12, ["lifetimeSpend"] = Money(1894.20m, "EUR"), ["createdAt"] = Instant(-410, 12)
        },
        nameof(RegisterCustomerRequest) => new JsonObject
        {
            ["email"] = "aoife.brennan@example.com", ["firstName"] = "Aoife", ["lastName"] = "Brennan", ["phone"] = "+353 86 220 1744", ["preferredCurrency"] = "EUR", ["marketingOptIn"] = true
        },
        nameof(UpdateCustomerRequest) => new JsonObject { ["firstName"] = "Mia", ["lastName"] = "Customer", ["phone"] = "+353 87 412 9083", ["preferredCurrency"] = "EUR", ["marketingOptIn"] = false },
        nameof(CustomerAddress) => new JsonObject { ["id"] = "f2b4d6e8-0a1c-4d35-9e71-2c4e6a8b0d13", ["kind"] = "Shipping", ["label"] = "Home", ["isDefault"] = true, ["address"] = Address() },
        nameof(AddAddressRequest) => new JsonObject { ["kind"] = "Shipping", ["label"] = "Office", ["makeDefault"] = false, ["address"] = Address() },
        nameof(CartItem) => new JsonObject
        {
            ["id"] = "c9e1a3b5-7d2f-4a48-8b60-4f6a8c0e2d31", ["variant"] = Variant(), ["quantity"] = 1, ["unitPrice"] = Money(188.99m, "EUR"), ["lineTotal"] = Money(188.99m, "EUR"), ["available"] = 40
        },
        nameof(Cart) => new JsonObject
        {
            ["id"] = "0d2f4b6a-8c1e-4f73-a5b9-3e7c1a9d5f08", ["customer"] = Customer(), ["currency"] = "EUR", ["couponCode"] = "ACME10",
            ["items"] = new JsonArray(new JsonObject { ["id"] = "c9e1a3b5-7d2f-4a48-8b60-4f6a8c0e2d31", ["variant"] = Variant(), ["quantity"] = 1, ["unitPrice"] = Money(188.99m, "EUR"), ["lineTotal"] = Money(188.99m, "EUR"), ["available"] = 40 }),
            ["totals"] = Totals(), ["updatedAt"] = Instant(0, 9)
        },
        nameof(AddCartItemRequest) => new JsonObject { ["sku"] = DemoData.JacketSku, ["quantity"] = 1 },
        nameof(UpdateCartItemRequest) => new JsonObject { ["quantity"] = 2 },
        nameof(QuoteLineRequest) => new JsonObject { ["sku"] = DemoData.JacketSku, ["quantity"] = 1 },
        nameof(PriceQuoteRequest) => new JsonObject
        {
            ["items"] = new JsonArray(new JsonObject { ["sku"] = DemoData.JacketSku, ["quantity"] = 1 }, new JsonObject { ["sku"] = "SMF-SLO", ["quantity"] = 1 }),
            ["currency"] = "EUR", ["shippingSpeed"] = "Express", ["couponCode"] = "ACME10", ["country"] = "IE"
        },
        nameof(QuoteLine) => new JsonObject { ["variant"] = Variant(), ["quantity"] = 1, ["unitPrice"] = Money(188.99m, "EUR"), ["lineTotal"] = Money(188.99m, "EUR") },
        nameof(PriceQuote) => new JsonObject
        {
            ["id"] = "qt_7f3a9c1e04b2d68", ["lines"] = new JsonArray(new JsonObject { ["variant"] = Variant(), ["quantity"] = 1, ["unitPrice"] = Money(188.99m, "EUR"), ["lineTotal"] = Money(188.99m, "EUR") }),
            ["totals"] = Totals(), ["validUntil"] = Instant(0, 15)
        },
        nameof(CardPayment) => new JsonObject { ["type"] = "Card", ["token"] = "tok_visa_4242", ["brand"] = "Visa", ["holderName"] = "Mia Customer" },
        nameof(BankTransferPayment) => new JsonObject { ["type"] = "BankTransfer", ["bankName"] = "AIB", ["accountHolder"] = "Mia Customer" },
        nameof(GiftCardPayment) => new JsonObject { ["type"] = "GiftCard", ["code"] = "GIFT-7K2M-9QXA-4D8P" },
        nameof(OrderLineRequest) => new JsonObject { ["sku"] = DemoData.JacketSku, ["quantity"] = 1 },
        nameof(PlaceOrderRequest) => new JsonObject
        {
            ["customerId"] = DemoData.MiaId,
            ["items"] = new JsonArray(new JsonObject { ["sku"] = DemoData.JacketSku, ["quantity"] = 1 }),
            ["currency"] = "EUR", ["shippingAddress"] = Address(), ["shippingSpeed"] = "Express", ["couponCode"] = "ACME10",
            ["payment"] = new JsonObject { ["type"] = "Card", ["token"] = "tok_visa_4242", ["brand"] = "Visa", ["holderName"] = "Mia Customer" },
            ["note"] = "Please leave with the neighbour."
        },
        nameof(OrderLine) => Line(),
        nameof(PaymentReference) => new JsonObject { ["id"] = PaymentId, ["method"] = "Visa •••• 4242", ["status"] = "Captured" },
        nameof(ShipmentReference) => new JsonObject { ["id"] = ShipmentId, ["carrier"] = "Dhl", ["trackingNumber"] = "JD014600004512493", ["status"] = "InTransit" },
        nameof(OrderSummary) => new JsonObject
        {
            ["id"] = OrderId, ["number"] = "AS-2026-004512", ["status"] = "Shipped", ["customer"] = Customer(), ["total"] = Money(170.10m, "EUR"), ["itemCount"] = 1, ["placedAt"] = Instant(-3, 10)
        },
        nameof(Order) => Order(),
        nameof(CancelOrderRequest) => new JsonObject { ["reason"] = "Ordered the wrong size." },
        nameof(OrderEvent) => new JsonObject { ["type"] = "Order.Placed", ["at"] = Instant(-3, 10), ["actor"] = Actor(), ["status"] = "Paid", ["summary"] = "Order AS-2026-004512 placed for 170.10 EUR." },
        nameof(OrderTimeline) => new JsonObject
        {
            ["orderId"] = OrderId, ["number"] = "AS-2026-004512",
            ["events"] = new JsonArray(
                new JsonObject { ["type"] = "Order.Placed", ["at"] = Instant(-3, 10), ["actor"] = Actor(), ["status"] = "Paid", ["summary"] = "Order AS-2026-004512 placed for 170.10 EUR." },
                new JsonObject { ["type"] = "Payment.Captured", ["at"] = Instant(-3, 10), ["actor"] = Actor(), ["status"] = "Paid", ["summary"] = "Visa •••• 4242 accepted." },
                new JsonObject { ["type"] = "Shipment.Created", ["at"] = Instant(-2, 16), ["actor"] = new JsonObject { ["email"] = "wes.warehouse@acme.dev", ["name"] = "Wes Warehouse" }, ["status"] = "Shipped", ["summary"] = "Shipped with Dhl, tracking JD014600004512493." }),
            ["updatedAt"] = Instant(-2, 16)
        },
        nameof(Refund) => Refund(),
        nameof(Payment) => new JsonObject
        {
            ["id"] = PaymentId, ["orderId"] = OrderId, ["orderNumber"] = "AS-2026-004512", ["method"] = "Card", ["methodDisplay"] = "Visa •••• 4242", ["status"] = "PartiallyRefunded",
            ["amount"] = Money(170.10m, "EUR"), ["refunded"] = Money(24.50m, "EUR"), ["providerReference"] = "pay_8c0e2a4b6d1f3a5", ["refunds"] = new JsonArray(Refund()), ["createdAt"] = Instant(-3, 10)
        },
        nameof(RefundRequest) => new JsonObject { ["amount"] = 24.50, ["currency"] = "EUR", ["reason"] = "Damaged", ["note"] = "Zip arrived broken." },
        nameof(TrackingEvent) => new JsonObject { ["at"] = Instant(-1, 12), ["location"] = "Leipzig, DE", ["description"] = "Arrived at the sorting centre." },
        nameof(Shipment) => Shipment(),
        nameof(CreateShipmentRequest) => new JsonObject { ["orderId"] = OrderId, ["carrier"] = "Dhl", ["estimatedDelivery"] = Date(3) },
        nameof(ReviewAuthor) => new JsonObject { ["name"] = "Aoife M.", ["verifiedPurchase"] = true },
        nameof(ReviewReply) => new JsonObject { ["by"] = "Acme Store Support", ["text"] = "Thank you for the kind words!", ["at"] = Instant(-10, 9) },
        nameof(Review) => Review(),
        nameof(RatingBucket) => new JsonObject { ["stars"] = 5, ["count"] = 6 },
        nameof(ReviewPage) => new JsonObject
        {
            ["productId"] = DemoData.JacketId, ["average"] = 4.6, ["count"] = 9,
            ["distribution"] = new JsonArray(new JsonObject { ["stars"] = 5, ["count"] = 6 }, new JsonObject { ["stars"] = 4, ["count"] = 2 }, new JsonObject { ["stars"] = 3, ["count"] = 1 },
                new JsonObject { ["stars"] = 2, ["count"] = 0 }, new JsonObject { ["stars"] = 1, ["count"] = 0 }),
            ["reviews"] = new JsonArray(Review())
        },
        nameof(AddReviewRequest) => new JsonObject
        {
            ["rating"] = 5, ["title"] = "Survived a week of Atlantic rain", ["body"] = "Kept me dry on the Wicklow Way through three days of proper rain.", ["customerId"] = DemoData.MiaId
        },
        nameof(ReviewVoteRequest) => new JsonObject { ["helpful"] = true },
        nameof(PercentageCoupon) => new JsonObject
        {
            ["kind"] = "Percentage", ["code"] = "SPRING15", ["description"] = "Spring sale: 15% off orders over 50.", ["percentOff"] = 15, ["minSubtotal"] = 50, ["expiresOn"] = Date(40),
            ["id"] = "c0000000-0000-4000-8000-000000000002", ["redeemed"] = 38, ["isActive"] = true
        },
        nameof(FixedAmountCoupon) => new JsonObject
        {
            ["kind"] = "FixedAmount", ["code"] = "SAVE15EUR", ["description"] = "15 euro off orders over 100 euro.", ["amountOff"] = 15, ["currency"] = "EUR", ["minSubtotal"] = 100,
            ["id"] = "c0000000-0000-4000-8000-000000000005", ["redeemed"] = 12, ["isActive"] = true
        },
        nameof(FreeShippingCoupon) => new JsonObject
        {
            ["kind"] = "FreeShipping", ["code"] = "FREESHIP", ["description"] = "Free shipping on any order, for newsletter subscribers.", ["maxRedemptions"] = 1000,
            ["id"] = "c0000000-0000-4000-8000-000000000003", ["redeemed"] = 74, ["isActive"] = true
        },
        nameof(Coupon) => new JsonObject { ["kind"] = "Percentage", ["code"] = "WELCOME15", ["description"] = "Welcome offer: 15% off a first order.", ["percentOff"] = 15, ["maxRedemptions"] = 2000 },
        nameof(CouponCheck) => new JsonObject { ["code"] = "SPRING15", ["valid"] = true, ["discount"] = Money(28.35m, "EUR") },
        nameof(RedeemCouponRequest) => new JsonObject { ["count"] = 3, ["orderNumber"] = "AS-2026-004512" },
        nameof(CouponRedemption) => new JsonObject { ["code"] = "VIPDAYS", ["redeemed"] = 115, ["remaining"] = 185 },
        nameof(User) => new JsonObject { ["id"] = 2, ["email"] = "sam.support@acme.dev", ["name"] = "Sam Support", ["role"] = "support", ["jobTitle"] = "Customer Support Lead", ["isActive"] = true },
        nameof(Role) => new JsonObject
        {
            ["name"] = "support", ["description"] = "Helps customers with orders and payments.",
            ["permissions"] = new JsonArray("Read customers, orders, payments and coupons", "Place and cancel orders for customers", "Refund payments"), ["userCount"] = 2
        },
        nameof(ChangeRoleRequest) => new JsonObject { ["role"] = "support" },
        _ => null
    };
}
