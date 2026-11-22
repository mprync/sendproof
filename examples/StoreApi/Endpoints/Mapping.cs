using System.Text.Json;
using Microsoft.EntityFrameworkCore;

namespace StoreApi;

/// <summary>Maps persistence records to the contracts the API returns, loading related rows in bulk.</summary>
internal static class Mapping
{
    /// <summary>Maps a stored role name to the documented enum.</summary>
    internal static RoleName ToRole(string role) => role switch
    {
        "admin" => RoleName.Admin,
        "support" => RoleName.Support,
        "warehouse" => RoleName.Warehouse,
        _ => RoleName.Customer
    };

    /// <summary>Maps a documented role to the stored role name.</summary>
    internal static string ToRoleClaim(RoleName role) => role switch
    {
        RoleName.Admin => "admin",
        RoleName.Support => "support",
        RoleName.Warehouse => "warehouse",
        _ => "customer"
    };

    internal static User ToContract(this DemoUser user) => new()
    {
        Id = user.Id, Email = user.Email, Name = user.Name, Role = ToRole(user.Role), JobTitle = user.JobTitle, IsActive = user.IsActive
    };

    internal static Address ToAddress(this AddressRecord a) => new()
    {
        Recipient = a.Recipient, Line1 = a.Line1, Line2 = a.Line2, City = a.City, Region = a.Region, PostalCode = a.PostalCode, Country = a.Country
    };

    internal static CustomerAddress ToContract(this AddressRecord a) =>
        new() { Id = a.Id, Kind = a.Kind, Label = a.Label, IsDefault = a.IsDefault, Address = a.ToAddress() };

    internal static string FullName(this CustomerRecord c) => $"{c.FirstName} {c.LastName}";

    internal static CustomerReference ToReference(this CustomerRecord c) => new() { Id = c.Id, Name = c.FullName(), Email = c.Email };

    internal static CategoryReference ToReference(this CategoryRecord c) => new() { Id = c.Id, Name = c.Name };

    /// <summary>Maps customers with their order count and lifetime spend.</summary>
    internal static async Task<IReadOnlyList<Customer>> ToContractsAsync(this IReadOnlyList<CustomerRecord> customers, StoreDbContext db)
    {
        var ids = customers.Select(c => c.Id).ToList();
        var orders = (await db.Orders.AsNoTracking().Where(o => ids.Contains(o.CustomerId) && o.Status != OrderStatus.Cancelled).ToListAsync())
            .ToLookup(o => o.CustomerId);
        return customers.Select(c =>
        {
            var mine = orders[c.Id].ToList();
            // Spend is summed in US dollars at the catalogue rate and reported in the customer's preferred currency.
            return new Customer
            {
                Id = c.Id, Email = c.Email, Name = c.FullName(), FirstName = c.FirstName, LastName = c.LastName, Phone = c.Phone,
                PreferredCurrency = c.PreferredCurrency, Tier = c.Tier, MarketingOptIn = c.MarketingOptIn, OrderCount = mine.Count,
                LifetimeSpend = EndpointSupport.ToMoney(decimal.Round(mine.Sum(o => ToUsd(o.Total, o.Currency)) * Pricing.Rate(c.PreferredCurrency), EndpointSupport.Decimals(c.PreferredCurrency)), c.PreferredCurrency),
                CreatedAt = c.CreatedAt
            };
        }).ToList();
    }

    /// <summary>An amount in US dollars: the inverse of the catalogue's currency rate (<c>Pricing.Convert(1, …)</c> without rounding).</summary>
    private static decimal ToUsd(decimal amount, Currency currency) => amount / Pricing.Rate(currency);

    internal static async Task<Customer> ToContractAsync(this CustomerRecord customer, StoreDbContext db) =>
        (await new[] { customer }.ToContractsAsync(db))[0];

    /// <summary>Loads the variant references for a set of variant IDs, naming each with its product.</summary>
    internal static async Task<Dictionary<Guid, VariantReference>> VariantReferencesAsync(this StoreDbContext db, IEnumerable<Guid> variantIds)
    {
        var ids = variantIds.Distinct().ToList();
        var variants = await db.Variants.AsNoTracking().Where(v => ids.Contains(v.Id)).ToListAsync();
        var productIds = variants.Select(v => v.ProductId).Distinct().ToList();
        var products = await db.Products.AsNoTracking().Where(p => productIds.Contains(p.Id)).ToDictionaryAsync(p => p.Id, p => p.Name);
        return variants.ToDictionary(v => v.Id, v => new VariantReference { Id = v.Id, Sku = v.Sku, Name = $"{products[v.ProductId]}, {v.Name}" });
    }

    /// <summary>Maps products to list items priced in one currency.</summary>
    internal static async Task<IReadOnlyList<ProductSummary>> ToSummariesAsync(this IReadOnlyList<ProductRecord> products, StoreDbContext db, Currency currency)
    {
        var ids = products.Select(p => p.Id).ToList();
        var categoryIds = products.Select(p => p.CategoryId).Distinct().ToList();
        var categories = await db.Categories.AsNoTracking().Where(c => categoryIds.Contains(c.Id)).ToDictionaryAsync(c => c.Id);
        var variants = (await db.Variants.AsNoTracking().Where(v => ids.Contains(v.ProductId)).ToListAsync()).ToLookup(v => v.ProductId);
        var variantIds = variants.SelectMany(g => g).Select(v => v.Id).ToList();
        var prices = (await db.Prices.AsNoTracking().Where(p => variantIds.Contains(p.VariantId) && p.Currency == currency).ToListAsync())
            .ToDictionary(p => p.VariantId, p => p.Amount);
        var stock = (await db.Stock.AsNoTracking().Where(s => variantIds.Contains(s.VariantId)).ToListAsync())
            .ToDictionary(s => s.VariantId, s => s.OnHand - s.Reserved);
        return products.Select(p => new ProductSummary
        {
            Id = p.Id, Slug = p.Slug, Name = p.Name, Brand = p.Brand, Category = categories[p.CategoryId].ToReference(), Status = p.Status,
            Price = EndpointSupport.ToMoney(variants[p.Id].Select(v => prices.GetValueOrDefault(v.Id)).Where(x => x > 0).DefaultIfEmpty(0m).Min(), currency),
            Rating = p.RatingAverage, ReviewCount = p.ReviewCount,
            InStock = variants[p.Id].Any(v => stock.GetValueOrDefault(v.Id) > 0), Tags = Tags(p)
        }).ToList();
    }

    internal static IReadOnlyList<string> Tags(ProductRecord p) =>
        string.IsNullOrEmpty(p.Tags) ? [] : p.Tags.Split(',', StringSplitOptions.RemoveEmptyEntries);

    /// <summary>Maps one product with its variants, prices in every currency and availability.</summary>
    internal static async Task<Product> ToContractAsync(this ProductRecord p, StoreDbContext db)
    {
        var category = await db.Categories.AsNoTracking().SingleAsync(c => c.Id == p.CategoryId);
        var variants = await db.Variants.AsNoTracking().Where(v => v.ProductId == p.Id).OrderBy(v => v.Sku).ToListAsync();
        var ids = variants.Select(v => v.Id).ToList();
        var prices = (await db.Prices.AsNoTracking().Where(x => ids.Contains(x.VariantId)).ToListAsync()).ToLookup(x => x.VariantId);
        var stock = (await db.Stock.AsNoTracking().Where(s => ids.Contains(s.VariantId)).ToListAsync()).ToDictionary(s => s.VariantId, s => s.OnHand - s.Reserved);
        return new Product
        {
            Id = p.Id, Slug = p.Slug, Name = p.Name, Brand = p.Brand, Description = p.Description, Category = category.ToReference(),
            Status = p.Status, Tags = Tags(p), WeightGrams = p.WeightGrams,
            Dimensions = new Dimensions { WidthCm = p.WidthCm, HeightCm = p.HeightCm, DepthCm = p.DepthCm },
            Rating = p.RatingAverage, ReviewCount = p.ReviewCount,
            Variants = variants.Select(v => new Variant
            {
                Id = v.Id, Sku = v.Sku, Name = v.Name, Color = v.Color, Size = v.Size, Barcode = v.Barcode,
                Prices = prices[v.Id].OrderBy(x => x.Currency).Select(x => EndpointSupport.ToMoney(x.Amount, x.Currency)).ToList(),
                Available = stock.GetValueOrDefault(v.Id)
            }).ToList(),
            CreatedAt = p.CreatedAt, UpdatedAt = p.UpdatedAt
        };
    }

    /// <summary>Maps stock rows to levels, naming each variant.</summary>
    internal static async Task<IReadOnlyList<StockLevel>> ToLevelsAsync(this IReadOnlyList<StockRecord> rows, StoreDbContext db)
    {
        var names = await db.VariantReferencesAsync(rows.Select(r => r.VariantId));
        return rows.Select(r => r.ToLevel(names[r.VariantId])).ToList();
    }

    internal static StockLevel ToLevel(this StockRecord r, VariantReference variant) => new()
    {
        VariantId = variant.Id, Sku = variant.Sku, Name = variant.Name, Warehouse = r.Warehouse, OnHand = r.OnHand, Reserved = r.Reserved, Available = r.OnHand - r.Reserved,
        ReorderPoint = r.ReorderPoint, IsLow = r.OnHand - r.Reserved <= r.ReorderPoint, UpdatedAt = r.UpdatedAt
    };

    /// <summary>Maps a coupon record to the documented union.</summary>
    internal static Coupon ToContract(this CouponRecord c)
    {
        Coupon coupon = c.Kind switch
        {
            CouponKind.Percentage => new PercentageCoupon { PercentOff = c.PercentOff ?? 0 },
            CouponKind.FixedAmount => new FixedAmountCoupon { AmountOff = c.AmountOff ?? 0, Currency = (c.Currency ?? StoreApi.Currency.USD).ToString() },
            _ => new FreeShippingCoupon()
        };
        coupon.Id = c.Id; coupon.Code = c.Code; coupon.Description = c.Description; coupon.MinSubtotal = c.MinSubtotal;
        coupon.MaxRedemptions = c.MaxRedemptions; coupon.ExpiresOn = c.ExpiresOn; coupon.Redeemed = c.Redeemed; coupon.IsActive = c.IsActive;
        return coupon;
    }

    internal static Refund ToContract(this RefundRecord r) => new()
    {
        Id = r.Id, Amount = EndpointSupport.ToMoney(r.Amount, r.Currency), Reason = r.Reason, Note = r.Note, CreatedBy = r.CreatedBy, CreatedAt = r.CreatedAt
    };

    /// <summary>Maps payments to contracts with their order numbers and refunds.</summary>
    internal static async Task<IReadOnlyList<Payment>> ToContractsAsync(this IReadOnlyList<PaymentRecord> payments, StoreDbContext db)
    {
        var ids = payments.Select(p => p.Id).ToList();
        var orderIds = payments.Select(p => p.OrderId).ToList();
        var numbers = await db.Orders.AsNoTracking().Where(o => orderIds.Contains(o.Id)).ToDictionaryAsync(o => o.Id, o => o.Number);
        var refunds = (await db.Refunds.AsNoTracking().Where(r => ids.Contains(r.PaymentId)).ToListAsync()).OrderBy(r => r.CreatedAt).ToLookup(r => r.PaymentId);
        return payments.Select(p => new Payment
        {
            Id = p.Id, OrderId = p.OrderId, OrderNumber = numbers[p.OrderId], Method = p.Method, MethodDisplay = p.MethodDisplay, Status = p.Status,
            Amount = EndpointSupport.ToMoney(p.Amount, p.Currency), Refunded = EndpointSupport.ToMoney(p.RefundedAmount, p.Currency),
            ProviderReference = p.ProviderReference, Refunds = refunds[p.Id].Select(r => r.ToContract()).ToList(),
            FailureReason = p.FailureReason, CreatedAt = p.CreatedAt
        }).ToList();
    }

    internal static async Task<Payment> ToContractAsync(this PaymentRecord payment, StoreDbContext db) =>
        (await new[] { payment }.ToContractsAsync(db))[0];

    /// <summary>Maps shipments to contracts with their order numbers and scans.</summary>
    internal static async Task<IReadOnlyList<Shipment>> ToContractsAsync(this IReadOnlyList<ShipmentRecord> shipments, StoreDbContext db)
    {
        var orderIds = shipments.Select(s => s.OrderId).ToList();
        var numbers = await db.Orders.AsNoTracking().Where(o => orderIds.Contains(o.Id)).ToDictionaryAsync(o => o.Id, o => o.Number);
        return shipments.Select(s => new Shipment
        {
            Id = s.Id, OrderId = s.OrderId, OrderNumber = numbers[s.OrderId], Carrier = s.Carrier, TrackingNumber = s.TrackingNumber,
            Status = s.Status, Events = JsonSerializer.Deserialize<List<TrackingEvent>>(s.EventsJson) ?? [],
            ShippedAt = s.ShippedAt, EstimatedDelivery = s.EstimatedDelivery, DeliveredAt = s.DeliveredAt
        }).ToList();
    }

    internal static async Task<Shipment> ToContractAsync(this ShipmentRecord shipment, StoreDbContext db) =>
        (await new[] { shipment }.ToContractsAsync(db))[0];

    /// <summary>Maps orders to list items.</summary>
    internal static async Task<IReadOnlyList<OrderSummary>> ToSummariesAsync(this IReadOnlyList<OrderRecord> orders, StoreDbContext db)
    {
        var ids = orders.Select(o => o.Id).ToList();
        var customerIds = orders.Select(o => o.CustomerId).Distinct().ToList();
        var customers = await db.Customers.AsNoTracking().Where(c => customerIds.Contains(c.Id)).ToDictionaryAsync(c => c.Id);
        var counts = (await db.OrderLines.AsNoTracking().Where(l => ids.Contains(l.OrderId)).ToListAsync())
            .GroupBy(l => l.OrderId).ToDictionary(g => g.Key, g => g.Sum(l => l.Quantity));
        return orders.Select(o => new OrderSummary
        {
            Id = o.Id, Number = o.Number, Status = o.Status, Customer = customers[o.CustomerId].ToReference(),
            Total = EndpointSupport.ToMoney(o.Total, o.Currency), ItemCount = counts.GetValueOrDefault(o.Id), PlacedAt = o.PlacedAt
        }).ToList();
    }

    /// <summary>Maps one order with its lines, totals, payment and shipments.</summary>
    internal static async Task<Order> ToContractAsync(this OrderRecord o, StoreDbContext db)
    {
        var customer = await db.Customers.AsNoTracking().SingleAsync(c => c.Id == o.CustomerId);
        var lines = await db.OrderLines.AsNoTracking().Where(l => l.OrderId == o.Id).ToListAsync();
        var payment = await db.Payments.AsNoTracking().Where(p => p.OrderId == o.Id).OrderBy(p => p.CreatedAt).FirstOrDefaultAsync();
        var shipments = (await db.Shipments.AsNoTracking().Where(s => s.OrderId == o.Id).ToListAsync()).OrderBy(s => s.ShippedAt).ToList();
        var placedBy = await db.Users.AsNoTracking().Where(u => u.Email == o.PlacedBy).Select(u => u.Name).FirstOrDefaultAsync();
        var variants = await db.VariantReferencesAsync(lines.Select(l => l.VariantId));
        return new Order
        {
            Id = o.Id, Number = o.Number, Status = o.Status, Customer = customer.ToReference(),
            Lines = lines.Select(l => new OrderLine
            {
                Id = l.Id, Variant = variants.TryGetValue(l.VariantId, out var v) ? v : new VariantReference { Id = l.VariantId, Sku = l.Sku, Name = l.Name },
                Quantity = l.Quantity, UnitPrice = EndpointSupport.ToMoney(l.UnitPrice, o.Currency), LineTotal = EndpointSupport.ToMoney(l.LineTotal, o.Currency)
            }).ToList(),
            Totals = new OrderTotals
            {
                Subtotal = EndpointSupport.ToMoney(o.Subtotal, o.Currency), Discount = EndpointSupport.ToMoney(o.Discount, o.Currency),
                Shipping = EndpointSupport.ToMoney(o.ShippingCost, o.Currency), Tax = EndpointSupport.ToMoney(o.Tax, o.Currency),
                Total = EndpointSupport.ToMoney(o.Total, o.Currency)
            },
            CouponCode = o.CouponCode, ShippingSpeed = o.ShippingSpeed,
            ShippingAddress = new Address
            {
                Recipient = o.ShipToName, Line1 = o.ShipToLine1, Line2 = o.ShipToLine2, City = o.ShipToCity, Region = o.ShipToRegion,
                PostalCode = o.ShipToPostalCode, Country = o.ShipToCountry
            },
            Payment = payment is null ? null : new PaymentReference { Id = payment.Id, Method = payment.MethodDisplay, Status = payment.Status },
            Shipments = shipments.Select(s => new ShipmentReference { Id = s.Id, Carrier = s.Carrier, TrackingNumber = s.TrackingNumber, Status = s.Status }).ToList(),
            Note = o.Note, CancelReason = o.CancelReason,
            PlacedBy = new ActorReference { Email = o.PlacedBy, Name = placedBy ?? o.PlacedBy },
            PlacedAt = o.PlacedAt, UpdatedAt = o.UpdatedAt
        };
    }
}
