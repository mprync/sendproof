using System.Text.Json;

namespace StoreApi;

/// <summary>Everything the order seed produces.</summary>
internal sealed record OrderData(List<OrderRecord> Orders, List<OrderLineRecord> Lines, List<PaymentRecord> Payments, List<RefundRecord> Refunds,
    List<ShipmentRecord> Shipments, List<StockRecord> Stock, List<StockMovementRecord> Movements, List<ReservationRecord> Reservations,
    List<CartRecord> Carts, List<CartItemRecord> CartItems, List<AuditEventRecord> Audit);

/// <summary>Seeds coupons, then about 140 orders with their payments, refunds, shipments, stock levels and carts.</summary>
internal static class OrderSeed
{
    private static readonly string[] CardBrands = ["Visa", "Mastercard", "Amex"];
    private static readonly string[] Banks = ["AIB", "Bank of Ireland", "Deutsche Bank", "Barclays", "Chase", "RBC", "Commonwealth Bank"];

    /// <summary>The seeded coupons: active, expired, exhausted and switched off.</summary>
    internal static List<CouponRecord> Coupons(DateTimeOffset now)
    {
        var today = DateOnly.FromDateTime(now.UtcDateTime);
        return
        [
            new() { Id = Guid.Parse("c0000000-0000-4000-8000-000000000001"), Code = "ACME10", Kind = CouponKind.Percentage, PercentOff = 10, Description = "Welcome offer: 10% off a first order.", MaxRedemptions = 5000, Redeemed = 0 },
            new() { Id = Guid.Parse("c0000000-0000-4000-8000-000000000002"), Code = "SPRING15", Kind = CouponKind.Percentage, PercentOff = 15, MinSubtotal = 50, Description = "Spring sale: 15% off orders over 50 in any currency of the same value.", ExpiresOn = today.AddDays(40) },
            new() { Id = Guid.Parse("c0000000-0000-4000-8000-000000000003"), Code = "FREESHIP", Kind = CouponKind.FreeShipping, Description = "Free shipping on any order, for newsletter subscribers." },
            new() { Id = Guid.Parse("c0000000-0000-4000-8000-000000000004"), Code = "SAVE20USD", Kind = CouponKind.FixedAmount, AmountOff = 20, Currency = Currency.USD, MinSubtotal = 120, Description = "20 US dollars off orders over 120 US dollars." },
            new() { Id = Guid.Parse("c0000000-0000-4000-8000-000000000005"), Code = "SAVE15EUR", Kind = CouponKind.FixedAmount, AmountOff = 15, Currency = Currency.EUR, MinSubtotal = 100, Description = "15 euro off orders over 100 euro." },
            new() { Id = Guid.Parse("c0000000-0000-4000-8000-000000000006"), Code = "SAVE10GBP", Kind = CouponKind.FixedAmount, AmountOff = 10, Currency = Currency.GBP, MinSubtotal = 80, Description = "10 pounds off orders over 80 pounds." },
            new() { Id = Guid.Parse("c0000000-0000-4000-8000-000000000007"), Code = "VIPDAYS", Kind = CouponKind.Percentage, PercentOff = 20, MaxRedemptions = 300, Redeemed = 112, Description = "VIP days: 20% off for three days.", ExpiresOn = today.AddDays(9) },
            new() { Id = Guid.Parse("c0000000-0000-4000-8000-000000000008"), Code = "SUMMER25", Kind = CouponKind.Percentage, PercentOff = 25, Redeemed = 842, Description = "Summer clearance, 25% off. Ended.", ExpiresOn = today.AddDays(-60), IsActive = false },
            new() { Id = Guid.Parse("c0000000-0000-4000-8000-000000000009"), Code = "BLACKFRI", Kind = CouponKind.Percentage, PercentOff = 30, MaxRedemptions = 500, Redeemed = 500, Description = "Black Friday: 30% off. All 500 redeemed." },
            new() { Id = Guid.Parse("c0000000-0000-4000-8000-00000000000a"), Code = "TENTSALE", Kind = CouponKind.Percentage, PercentOff = 12, MinSubtotal = 250, Description = "12% off big orders, mostly tents.", ExpiresOn = today.AddDays(21) }
        ];
    }

    /// <summary>Creates the orders and everything that hangs off them.</summary>
    internal static OrderData Create(Random rng, DateTimeOffset now, People people, Catalogue catalogue, IReadOnlyList<CouponRecord> coupons)
    {
        var data = new OrderData([], [], [], [], [], [], [], [], [], [], []);
        var productsById = catalogue.Products.ToDictionary(p => p.Id);
        var sellable = catalogue.Variants.Where(v => productsById[v.ProductId].Status == ProductStatus.Active).ToList();
        var prices = catalogue.Prices.ToDictionary(p => (p.VariantId, p.Currency), p => p.Amount);
        var addresses = people.Addresses.Where(a => a.Kind == AddressKind.Shipping).GroupBy(a => a.CustomerId).ToDictionary(g => g.Key, g => g.OrderByDescending(a => a.IsDefault).First());
        var soldByVariant = new Dictionary<Guid, int>();
        var usable = coupons.Where(c => c.IsActive && c.Code is "ACME10" or "SPRING15" or "FREESHIP" or "SAVE20USD" or "SAVE15EUR" or "SAVE10GBP" or "TENTSALE").ToList();

        // Plan who orders when: regulars order often, everyone else a few times. Oldest first, so order numbers rise with time.
        var plan = new List<(CustomerRecord Customer, DateTimeOffset At)>();
        foreach (var customer in people.Customers)
        {
            var heavy = customer.Email.StartsWith("mia.", StringComparison.Ordinal) || customer.Email.StartsWith("noah.", StringComparison.Ordinal) || customer.Email.StartsWith("priya.", StringComparison.Ordinal) ||
                customer.Email.StartsWith("lena.", StringComparison.Ordinal) || customer.Email.StartsWith("omar.", StringComparison.Ordinal);
            var count = heavy ? rng.Between(9, 16) : customer.Email.StartsWith("liam.", StringComparison.Ordinal) ? 10 : rng.Between(1, 4);
            var oldest = (int)(now - customer.CreatedAt).TotalDays;
            for (var i = 0; i < count; i++)
                plan.Add((customer, now.AddDays(-Math.Pow(rng.NextDouble(), 1.6) * Math.Min(130, Math.Max(2, oldest))).AddMinutes(-rng.Between(0, 600))));
        }

        var sequence = 4500;
        foreach (var (customer, placedAt) in plan.OrderBy(p => p.At))
        {
            var currency = customer.PreferredCurrency;
            var address = addresses[customer.Id];
            var age = (now - placedAt).TotalDays;
            var status = ChooseStatus(rng, age);
            var lines = Enumerable.Range(0, rng.Between(1, 4)).Select(_ => rng.Pick(sellable)).DistinctBy(v => v.Id).ToList();
            var orderId = rng.NextGuid();
            var orderLines = lines.Select(v => new OrderLineRecord
            {
                Id = rng.NextGuid(), OrderId = orderId, VariantId = v.Id, Sku = v.Sku, Name = $"{productsById[v.ProductId].Name}, {v.Name}",
                Quantity = productsById[v.ProductId].Tags!.Contains("2-person") || productsById[v.ProductId].Tags!.Contains("3-person") ? 1 : rng.Between(1, 3),
                UnitPrice = prices[(v.Id, currency)]
            }).ToList();
            foreach (var line in orderLines) line.LineTotal = line.UnitPrice * line.Quantity;
            var subtotal = orderLines.Sum(l => l.LineTotal);
            CouponRecord? coupon = null;
            if (rng.Chance(0.28))
            {
                var candidate = rng.Pick(usable);
                if (Pricing.CouponProblem(candidate, subtotal, currency, DateOnly.FromDateTime(placedAt.UtcDateTime)) is null) coupon = candidate;
            }
            var speed = rng.NextDouble() switch { < 0.65 => ShippingSpeed.Standard, < 0.92 => ShippingSpeed.Express, _ => ShippingSpeed.NextDay };
            var totals = Pricing.Totals(subtotal, coupon, speed, currency, customer.Tier, address.Country);
            var method = status == OrderStatus.Pending ? PaymentMethodKind.BankTransfer : rng.NextDouble() switch { < 0.74 => PaymentMethodKind.Card, < 0.86 => PaymentMethodKind.BankTransfer, _ => PaymentMethodKind.GiftCard };
            var order = new OrderRecord
            {
                Id = orderId, Number = $"AS-{now.Year}-{sequence++:000000}", CustomerId = customer.Id, Status = status, Currency = currency,
                Subtotal = totals.Subtotal.Value, Discount = totals.Discount.Value, ShippingCost = totals.Shipping.Value, Tax = totals.Tax.Value, Total = totals.Total.Value,
                CouponCode = coupon?.Code, ShippingSpeed = speed, ShipToName = address.Recipient, ShipToLine1 = address.Line1, ShipToLine2 = address.Line2,
                ShipToCity = address.City, ShipToRegion = address.Region, ShipToPostalCode = address.PostalCode, ShipToCountry = address.Country,
                Note = rng.Chance(0.08) ? rng.Pick(new[] { "Please leave with the neighbour.", "Gift: no invoice in the parcel, please.", "Ring the bell twice." }) : null,
                PlacedBy = customer.Email, IdempotencyKey = rng.Chance(0.45) ? $"seed-{rng.NextGuid():N}"[..32] : null, RequestHash = rng.Hex(64),
                PlacedAt = placedAt, UpdatedAt = placedAt
            };
            if (coupon is not null && coupon.MaxRedemptions is null) coupon.Redeemed++;
            data.Orders.Add(order);
            data.Lines.AddRange(orderLines);
            data.Audit.Add(Audit(order, "Order.Placed", customer.Email, placedAt));

            AddPayment(rng, data, order, customer, method, status, age);
            AddShipment(rng, data, order, address, status, placedAt, now);

            // Stock: a placed order sells its lines at once; cancelling puts them back.
            foreach (var line in orderLines)
            {
                data.Movements.Add(new StockMovementRecord { Id = rng.NextGuid(), VariantId = line.VariantId, Delta = -line.Quantity, Reason = StockReason.Sold, Reference = order.Number, Actor = customer.Email, CreatedAt = placedAt });
                if (status == OrderStatus.Cancelled)
                    data.Movements.Add(new StockMovementRecord { Id = rng.NextGuid(), VariantId = line.VariantId, Delta = line.Quantity, Reason = StockReason.Returned, Reference = order.Number, Actor = customer.Email, CreatedAt = order.UpdatedAt });
                else soldByVariant[line.VariantId] = soldByVariant.GetValueOrDefault(line.VariantId) + line.Quantity;
                if (status is OrderStatus.Pending or OrderStatus.Paid or OrderStatus.Processing or OrderStatus.Cancelled)
                    data.Reservations.Add(new ReservationRecord
                    {
                        Id = rng.NextGuid(), VariantId = line.VariantId, Quantity = line.Quantity, OrderId = order.Id, CustomerId = customer.Id,
                        Status = status == OrderStatus.Cancelled ? ReservationStatus.Released : ReservationStatus.Committed, ExpiresAt = placedAt, CreatedAt = placedAt
                    });
            }
        }
        BuildStock(rng, now, data, catalogue, productsById, soldByVariant, people);
        return data;
    }

    private static OrderStatus ChooseStatus(Random rng, double ageDays)
    {
        var roll = rng.NextDouble();
        if (ageDays < 1) return roll < 0.3 ? OrderStatus.Pending : roll < 0.7 ? OrderStatus.Paid : OrderStatus.Processing;
        if (ageDays < 5) return roll < 0.08 ? OrderStatus.Cancelled : roll < 0.2 ? OrderStatus.Paid : roll < 0.5 ? OrderStatus.Processing : roll < 0.9 ? OrderStatus.Shipped : OrderStatus.Delivered;
        return roll < 0.06 ? OrderStatus.Cancelled : roll < 0.11 ? OrderStatus.Refunded : roll < 0.13 ? OrderStatus.Shipped : OrderStatus.Delivered;
    }

    private static AuditEventRecord Audit(OrderRecord order, string action, string actor, DateTimeOffset at) =>
        new() { Id = Guid.NewGuid(), EntityType = "Order", EntityId = order.Id.ToString(), Action = action, Actor = actor, CreatedAt = at };

    private static void AddPayment(Random rng, OrderData data, OrderRecord order, CustomerRecord customer, PaymentMethodKind method, OrderStatus status, double age)
    {
        var brand = rng.Pick(CardBrands);
        var display = method switch
        {
            PaymentMethodKind.Card => $"{brand} •••• {rng.Pick(new[] { "4242", "1881", "0005", "9424", "3704", "6011" })}",
            PaymentMethodKind.BankTransfer => $"Bank transfer from {rng.Pick(Banks)}",
            _ => $"Gift card GIFT-{rng.Hex(4)}…"
        };
        var payment = new PaymentRecord
        {
            Id = rng.NextGuid(), OrderId = order.Id, Method = method, Amount = order.Total, Currency = order.Currency, MethodDisplay = display,
            ProviderReference = $"pay_{rng.Hex(16).ToLowerInvariant()}", Status = status == OrderStatus.Pending ? PaymentStatus.Authorized : PaymentStatus.Captured, CreatedAt = order.PlacedAt
        };
        if (status == OrderStatus.Cancelled)
        {
            // Most cancelled orders were already captured and refunded; a few never got that far.
            if (rng.Chance(0.7)) AddRefund(rng, data, payment, payment.Amount, RefundReason.CustomerRequest, "Order cancelled", customer.Email, order.PlacedAt.AddHours(rng.Between(1, 20)));
            else { payment.Status = PaymentStatus.Failed; payment.FailureReason = "The order was cancelled before the payment was captured."; }
            order.CancelReason = rng.Pick(new[] { "Ordered the wrong size.", "Found it cheaper elsewhere.", "Changed my mind.", "Delivery would arrive after the trip." });
            order.UpdatedAt = order.PlacedAt.AddHours(rng.Between(1, 20));
            data.Audit.Add(Audit(order, $"Order.Cancelled: {order.CancelReason}", customer.Email, order.UpdatedAt));
        }
        else if (status == OrderStatus.Refunded)
        {
            AddRefund(rng, data, payment, payment.Amount, rng.Pick(new[] { RefundReason.Damaged, RefundReason.WrongItem, RefundReason.NotAsDescribed, RefundReason.CustomerRequest }),
                null, "sam.support@acme.dev", order.PlacedAt.AddDays(Math.Min(age - 0.5, rng.Between(6, 20))));
            order.UpdatedAt = data.Refunds[^1].CreatedAt;
        }
        else if (status == OrderStatus.Delivered && rng.Chance(0.08))
        {
            AddRefund(rng, data, payment, decimal.Round(payment.Amount * rng.Pick(new[] { 0.2m, 0.35m, 0.5m }), EndpointSupport.Decimals(payment.Currency)),
                RefundReason.Damaged, "One item arrived damaged; partial refund.", "pia.support@acme.dev", order.PlacedAt.AddDays(Math.Min(age - 0.2, rng.Between(5, 12))));
        }
        data.Payments.Add(payment);
    }

    private static void AddRefund(Random rng, OrderData data, PaymentRecord payment, decimal amount, RefundReason reason, string? note, string by, DateTimeOffset at)
    {
        data.Refunds.Add(new RefundRecord { Id = rng.NextGuid(), PaymentId = payment.Id, Amount = amount, Currency = payment.Currency, Reason = reason, Note = note, CreatedBy = by, CreatedAt = at });
        payment.RefundedAmount += amount;
        payment.Status = payment.RefundedAmount >= payment.Amount ? PaymentStatus.Refunded : PaymentStatus.PartiallyRefunded;
    }

    private static void AddShipment(Random rng, OrderData data, OrderRecord order, AddressRecord address, OrderStatus status, DateTimeOffset placedAt, DateTimeOffset now)
    {
        if (status is not (OrderStatus.Shipped or OrderStatus.Delivered or OrderStatus.Refunded)) return;
        var carrier = address.Country switch { "GB" => Carrier.RoyalMail, "CA" => Carrier.CanadaPost, _ => rng.Pick(new[] { Carrier.Ups, Carrier.Dhl, Carrier.FedEx }) };
        var shipped = placedAt.AddHours(rng.Between(8, 30));
        var days = order.ShippingSpeed switch { ShippingSpeed.Standard => 4, ShippingSpeed.Express => 2, _ => 1 };
        var delivered = shipped.AddDays(days).AddHours(rng.Between(-3, 6));
        var transit = rng.Pick(new[] { "Cologne, DE", "East Midlands, GB", "Roissy, FR", "Louisville, US", "Leipzig, DE" });
        var events = new List<TrackingEvent>
        {
            new() { At = shipped, Location = "Dublin, IE", Description = "Label created; the parcel is ready for collection." },
            new() { At = shipped.AddHours(5), Location = "Dublin, IE", Description = "Picked up by the carrier." },
            new() { At = shipped.AddHours(20), Location = transit, Description = "Arrived at the sorting centre." }
        };
        var shipmentStatus = ShipmentStatus.InTransit;
        DateTimeOffset? deliveredAt = null;
        if (status == OrderStatus.Shipped)
        {
            events = events.Where(e => e.At <= now).ToList();
            shipmentStatus = events.Count == 1 ? ShipmentStatus.LabelCreated : ShipmentStatus.InTransit;
        }
        else
        {
            events.Add(new TrackingEvent { At = delivered.AddHours(-5), Location = $"{address.City}, {address.Country}", Description = "Out for delivery." });
            events.Add(new TrackingEvent { At = delivered, Location = $"{address.City}, {address.Country}", Description = $"Delivered. Signed for by {address.Recipient.Split(' ')[0]}." });
            shipmentStatus = ShipmentStatus.Delivered;
            deliveredAt = delivered;
            order.UpdatedAt = status == OrderStatus.Refunded ? order.UpdatedAt : delivered;
            if (status == OrderStatus.Delivered) order.UpdatedAt = delivered;
        }
        if (status == OrderStatus.Shipped) order.UpdatedAt = shipped;
        data.Shipments.Add(new ShipmentRecord
        {
            Id = rng.NextGuid(), OrderId = order.Id, Carrier = carrier, TrackingNumber = ShipmentEndpoints.TrackingNumber(carrier, order.Number), Status = shipmentStatus,
            EventsJson = JsonSerializer.Serialize(events), ShippedAt = shipped, EstimatedDelivery = DateOnly.FromDateTime(shipped.UtcDateTime.AddDays(days)), DeliveredAt = deliveredAt
        });
    }

    /// <summary>
    /// Builds a stock row for every variant: the final level is drawn (some out of stock, some low, one fixed at exactly 40),
    /// and a <c>Received</c> movement makes the movement history add up to it. Also seeds the open carts and their holds.
    /// </summary>
    private static void BuildStock(Random rng, DateTimeOffset now, OrderData data, Catalogue catalogue, Dictionary<Guid, ProductRecord> products,
        Dictionary<Guid, int> sold, People people)
    {
        var stock = new Dictionary<Guid, StockRecord>();
        foreach (var variant in catalogue.Variants)
        {
            var roll = rng.NextDouble();
            var level = variant.Sku == DemoData.JacketSku ? 40 : roll < 0.06 ? 0 : roll < 0.20 ? rng.Between(1, 9) : roll < 0.45 ? rng.Between(10, 30) : rng.Between(31, 140);
            var damaged = level > 5 && rng.Chance(0.07) ? rng.Between(1, 3) : 0;
            var record = new StockRecord
            {
                Id = rng.NextGuid(), VariantId = variant.Id, Warehouse = products[variant.ProductId].Tags!.Contains("fuel") || products[variant.ProductId].Brand == "Fjordline" ? "COR-02" : "DUB-01",
                OnHand = level, ReorderPoint = variant.Sku == DemoData.JacketSku ? 10 : rng.Between(8, 20), UpdatedAt = now.AddDays(-rng.Between(0, 20))
            };
            stock[variant.Id] = record;
            data.Stock.Add(record);
            var received = level + sold.GetValueOrDefault(variant.Id) + damaged;
            data.Movements.Add(new StockMovementRecord
            {
                Id = rng.NextGuid(), VariantId = variant.Id, Delta = received, Reason = StockReason.Received, Reference = $"PO-{rng.Between(10000, 99999)}",
                Actor = "wes.warehouse@acme.dev", CreatedAt = now.AddDays(-rng.Between(135, 160))
            });
            if (damaged > 0)
                data.Movements.Add(new StockMovementRecord
                {
                    Id = rng.NextGuid(), VariantId = variant.Id, Delta = -damaged, Reason = StockReason.Damaged, Reference = "Cycle count", Actor = "wes.warehouse@acme.dev",
                    CreatedAt = now.AddDays(-rng.Between(10, 90))
                });
        }

        // Open carts: each customer with a cart holds its lines' stock for a few more minutes.
        var cartOwners = people.Customers.Where(c => c.Email.StartsWith("noah.") || c.Email.StartsWith("priya.") || c.Email.StartsWith("lena.") || c.Email.StartsWith("omar.")).ToList();
        cartOwners.AddRange(people.Customers.Where(c => !c.Email.Contains("acme.dev")).Take(5));
        var inStock = catalogue.Variants.Where(v => products[v.ProductId].Status == ProductStatus.Active && stock[v.Id].OnHand >= 6 && v.Sku != DemoData.JacketSku).ToList();
        foreach (var owner in cartOwners)
        {
            var cart = new CartRecord { Id = rng.NextGuid(), CustomerId = owner.Id, Currency = owner.PreferredCurrency, UpdatedAt = now.AddMinutes(-rng.Between(1, 11)) };
            data.Carts.Add(cart);
            foreach (var variant in Enumerable.Range(0, rng.Between(1, 3)).Select(_ => rng.Pick(inStock)).DistinctBy(v => v.Id))
            {
                var quantity = rng.Between(1, 2);
                data.CartItems.Add(new CartItemRecord { Id = rng.NextGuid(), CartId = cart.Id, VariantId = variant.Id, Quantity = quantity });
                data.Reservations.Add(new ReservationRecord
                {
                    Id = rng.NextGuid(), VariantId = variant.Id, Quantity = quantity, CustomerId = owner.Id, Status = ReservationStatus.Held,
                    ExpiresAt = now.AddMinutes(rng.Between(3, 14)), CreatedAt = cart.UpdatedAt
                });
                stock[variant.Id].Reserved += quantity;
            }
        }
    }
}
