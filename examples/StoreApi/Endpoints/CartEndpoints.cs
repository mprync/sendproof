using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using Sendproof.AspNetCore;

namespace StoreApi;

/// <summary>The cart operations: read a customer's cart, add, change and remove lines, and quote a price.</summary>
internal static class CartEndpoints
{
    /// <summary>How long a cart holds the stock of its lines.</summary>
    internal static readonly TimeSpan HoldLifetime = TimeSpan.FromMinutes(15);

    internal static void MapCartEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v2/customers/{customerId:guid}/cart").WithTags("Carts");
        group.MapGet("/", Get).WithName("CartsController.Get").RequireAuthorization(Policies.Shoppers)
            .Produces<Cart>().ProducesProblem(StatusCodes.Status403Forbidden).ProducesProblem(StatusCodes.Status404NotFound);
        group.MapPost("/items", AddItem).WithName("CartsController.AddItem").RequireAuthorization(Policies.Shoppers)
            .Produces<Cart>().ProducesValidationProblem().ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound).ProducesProblem(StatusCodes.Status409Conflict).WithSendproofPreview();
        group.MapPut("/items/{itemId:guid}", UpdateItem).WithName("CartsController.UpdateItem").RequireAuthorization(Policies.Shoppers)
            .Produces<Cart>().ProducesValidationProblem().ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound).ProducesProblem(StatusCodes.Status409Conflict).WithSendproofPreview();
        group.MapDelete("/items/{itemId:guid}", RemoveItem).WithName("CartsController.RemoveItem").RequireAuthorization(Policies.Shoppers)
            .Produces(StatusCodes.Status204NoContent).ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound).WithSendproofPreview();
        var quote = app.MapPost("/api/v2/quotes", Quote).WithTags("Carts").WithName("CartsController.Quote").RequireAuthorization()
            .Produces<PriceQuote>().ProducesValidationProblem().ProducesProblem(StatusCodes.Status409Conflict);
        // With Redis configured, quoting writes the quote to the cache, which a Preview cannot roll back: say so up front.
        if (app.ServiceProvider.GetRequiredService<DemoStores>().HasRedis)
            quote.WithSendproofPreview(enabled: false, reason: "Quotes are cached in Redis for 15 minutes.", "redis");
    }

    /// <summary>Get cart</summary>
    /// <remarks>
    /// Returns a customer's cart, priced in the cart's currency with **standard shipping** and any coupon applied. A line whose
    /// `available` is below its `quantity` cannot be ordered until stock arrives or the line is changed. A customer who has never added
    /// anything gets an empty cart. Customers can read only their own cart.
    /// </remarks>
    /// <param name="customerId">The customer's ID, from `CustomersController.List`.</param>
    /// <response code="200">The cart.</response>
    /// <response code="403">You are a customer and this is somebody else's cart.</response>
    /// <response code="404">No customer has this ID.</response>
    internal static async Task<IResult> Get(Guid customerId, StoreDbContext db, ClaimsPrincipal principal)
    {
        var customer = await db.Customers.AsNoTracking().SingleOrDefaultAsync(c => c.Id == customerId);
        if (customer is null) return EndpointSupport.NotFound("customer", customerId);
        if (!principal.CanActFor(customer)) return EndpointSupport.Forbidden(EndpointSupport.NotYours);
        var cart = await db.Carts.AsNoTracking().SingleOrDefaultAsync(c => c.CustomerId == customerId)
            ?? new CartRecord { Id = Guid.Empty, CustomerId = customerId, Currency = customer.PreferredCurrency, UpdatedAt = DateTimeOffset.UtcNow };
        return TypedResults.Ok(await ToContractAsync(db, cart, customer));
    }

    /// <summary>Add item to cart</summary>
    /// <remarks>
    /// Puts a variant in the customer's cart (adding to the line if it is already there) and **holds its stock** for 15 minutes, so it
    /// cannot be sold to someone else meanwhile. The answer is 409 when fewer units are available than you ask for. Preview shows the cart, stock
    /// and reservation rows this would change.
    /// </remarks>
    /// <param name="customerId">The customer's ID.</param>
    /// <param name="request">The variant and quantity to add.</param>
    /// <response code="200">The cart after the change.</response>
    /// <response code="400">The SKU or quantity was invalid.</response>
    /// <response code="403">You are a customer and this is somebody else's cart.</response>
    /// <response code="404">No customer has this ID.</response>
    /// <response code="409">Fewer units are available than you asked for.</response>
    internal static async Task<IResult> AddItem(Guid customerId, AddCartItemRequest request, StoreDbContext db, ClaimsPrincipal principal)
    {
        var customer = await db.Customers.SingleOrDefaultAsync(c => c.Id == customerId);
        if (customer is null) return EndpointSupport.NotFound("customer", customerId);
        if (!principal.CanActFor(customer)) return EndpointSupport.Forbidden(EndpointSupport.NotYours);
        var errors = EndpointSupport.Validate(request);
        var variant = await db.Variants.AsNoTracking().SingleOrDefaultAsync(v => v.Sku == request.Sku);
        if (variant is null) errors["sku"] = ["Choose an existing SKU."];
        else if (!await db.Products.AnyAsync(p => p.Id == variant.ProductId && p.Status == ProductStatus.Active)) errors["sku"] = ["This product is not on sale."];
        if (errors.Count > 0) return Results.ValidationProblem(errors);

        var cart = await db.Carts.SingleOrDefaultAsync(c => c.CustomerId == customerId);
        if (cart is null)
        {
            cart = new CartRecord { Id = Guid.NewGuid(), CustomerId = customerId, Currency = customer.PreferredCurrency };
            db.Carts.Add(cart);
        }
        var stock = await db.Stock.SingleAsync(s => s.VariantId == variant!.Id);
        var item = await db.CartItems.SingleOrDefaultAsync(i => i.CartId == cart.Id && i.VariantId == variant!.Id);
        var available = stock.OnHand - stock.Reserved;
        if (request.Quantity > available)
            return EndpointSupport.Conflict($"Only {available} of {request.Sku} {(available == 1 ? "is" : "are")} available; you asked for {request.Quantity}.");
        if (item is null)
        {
            item = new CartItemRecord { Id = Guid.NewGuid(), CartId = cart.Id, VariantId = variant!.Id, Quantity = request.Quantity };
            db.CartItems.Add(item);
        }
        else item.Quantity += request.Quantity;
        await HoldAsync(db, customerId, variant!.Id, stock, request.Quantity);
        cart.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync();
        return TypedResults.Ok(await ToContractAsync(db, cart, customer));
    }

    /// <summary>Change cart line</summary>
    /// <remarks>Sets the quantity of one cart line and adjusts the stock held for it. The answer is 409 when the extra units are not available.</remarks>
    /// <param name="customerId">The customer's ID.</param>
    /// <param name="itemId">The cart line's ID, from `CartsController.Get`.</param>
    /// <param name="request">The new quantity.</param>
    /// <response code="200">The cart after the change.</response>
    /// <response code="400">The quantity was invalid.</response>
    /// <response code="403">You are a customer and this is somebody else's cart.</response>
    /// <response code="404">The customer or the cart line does not exist.</response>
    /// <response code="409">The extra units are not available.</response>
    internal static async Task<IResult> UpdateItem(Guid customerId, Guid itemId, UpdateCartItemRequest request, StoreDbContext db, ClaimsPrincipal principal)
    {
        var customer = await db.Customers.SingleOrDefaultAsync(c => c.Id == customerId);
        if (customer is null) return EndpointSupport.NotFound("customer", customerId);
        if (!principal.CanActFor(customer)) return EndpointSupport.Forbidden(EndpointSupport.NotYours);
        var errors = EndpointSupport.Validate(request);
        if (errors.Count > 0) return Results.ValidationProblem(errors);
        var cart = await db.Carts.SingleOrDefaultAsync(c => c.CustomerId == customerId);
        var item = cart is null ? null : await db.CartItems.SingleOrDefaultAsync(i => i.Id == itemId && i.CartId == cart.Id);
        if (cart is null || item is null) return EndpointSupport.NotFound("cart line", itemId);
        var stock = await db.Stock.SingleAsync(s => s.VariantId == item.VariantId);
        var change = request.Quantity - item.Quantity;
        if (change > stock.OnHand - stock.Reserved)
            return EndpointSupport.Conflict($"Only {stock.OnHand - stock.Reserved} more are available; you asked for {change} more.");
        item.Quantity = request.Quantity;
        await HoldAsync(db, customerId, item.VariantId, stock, change);
        cart.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync();
        return TypedResults.Ok(await ToContractAsync(db, cart, customer));
    }

    /// <summary>Remove cart line</summary>
    /// <remarks>Deletes one line from the cart and releases the stock held for it.</remarks>
    /// <param name="customerId">The customer's ID.</param>
    /// <param name="itemId">The cart line's ID, from `CartsController.Get`.</param>
    /// <response code="204">The line was removed.</response>
    /// <response code="403">You are a customer and this is somebody else's cart.</response>
    /// <response code="404">The customer or the cart line does not exist.</response>
    internal static async Task<IResult> RemoveItem(Guid customerId, Guid itemId, StoreDbContext db, ClaimsPrincipal principal)
    {
        var customer = await db.Customers.AsNoTracking().SingleOrDefaultAsync(c => c.Id == customerId);
        if (customer is null) return EndpointSupport.NotFound("customer", customerId);
        if (!principal.CanActFor(customer)) return EndpointSupport.Forbidden(EndpointSupport.NotYours);
        var cart = await db.Carts.SingleOrDefaultAsync(c => c.CustomerId == customerId);
        var item = cart is null ? null : await db.CartItems.SingleOrDefaultAsync(i => i.Id == itemId && i.CartId == cart.Id);
        if (cart is null || item is null) return EndpointSupport.NotFound("cart line", itemId);
        var stock = await db.Stock.SingleAsync(s => s.VariantId == item.VariantId);
        await HoldAsync(db, customerId, item.VariantId, stock, -item.Quantity);
        db.CartItems.Remove(item);
        cart.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync();
        return Results.NoContent();
    }

    /// <summary>Quote price</summary>
    /// <remarks>
    /// Prices a basket without creating anything: the lines in `currency`, the coupon, shipping for the chosen speed, and the tax included for the
    /// delivery `country`. The quote is **held for 15 minutes**; pass its `id` as `quoteId` to `OrdersController.Place` and the customer is
    /// charged exactly this, or the order fails with 409 when a price moved in the meantime.
    ///
    /// With Redis configured the quote is cached there, so this operation writes to Redis and **cannot be previewed**: Sendproof marks it
    /// `preview: false` and a Preview answers 409. Reads of it are allowed in the Preview of an order.
    /// </remarks>
    /// <param name="request">What to price.</param>
    /// <response code="200">The quote.</response>
    /// <response code="400">A field was invalid.</response>
    /// <response code="409">Fewer units are available than a line asks for.</response>
    internal static async Task<IResult> Quote(PriceQuoteRequest request, StoreDbContext db, DemoStores stores)
    {
        var errors = EndpointSupport.Validate(request);
        var currency = EndpointSupport.ParseCurrency(request.Currency);
        if (currency is null) errors["currency"] = [$"Use one of: {EndpointSupport.CurrencyNames}."];
        var speed = EndpointSupport.ParseSpeed(request.ShippingSpeed);
        if (speed is null) errors["shippingSpeed"] = ["Use Standard, Express or Next day."];
        if (errors.Count > 0) return Results.ValidationProblem(errors);

        var priced = await PriceLinesAsync(db, request.Items.Select(i => (i.Sku, i.Quantity)).ToList(), currency!.Value, errors, "items");
        if (errors.Remove(StockShortKey, out var shortage)) return EndpointSupport.Conflict(shortage[0]);
        if (errors.Count > 0) return Results.ValidationProblem(errors);
        CouponRecord? coupon = null;
        if (!string.IsNullOrWhiteSpace(request.CouponCode))
        {
            coupon = await db.Coupons.AsNoTracking().SingleOrDefaultAsync(c => c.Code == request.CouponCode);
            var subtotal = priced!.Sum(l => l.Line.Value);
            var problem = coupon is null ? "No such coupon." : Pricing.CouponProblem(coupon, subtotal, currency.Value, DateOnly.FromDateTime(DateTime.UtcNow));
            if (problem is not null) return Results.ValidationProblem(new Dictionary<string, string[]> { ["couponCode"] = [problem] });
        }
        var quote = new PriceQuote
        {
            Id = $"qt_{Guid.NewGuid():N}"[..19],
            Lines = priced!.Select(l => new QuoteLine
            {
                Variant = l.Variant, Quantity = l.Quantity, UnitPrice = EndpointSupport.ToMoney(l.Unit, currency.Value), LineTotal = EndpointSupport.ToMoney(l.Line.Value, currency.Value)
            }).ToList(),
            Totals = Pricing.Totals(priced!.Sum(l => l.Line.Value), coupon, speed!.Value, currency.Value, CustomerTier.Standard, request.Country),
            ValidUntil = DateTimeOffset.UtcNow.Add(DemoStores.QuoteLifetime)
        };
        await stores.CacheQuoteAsync(quote); // Redis, for its 15 minutes; a no-op without DemoRedisUrl
        return TypedResults.Ok(quote);
    }

    /// <summary>The key under which <see cref="PriceLinesAsync"/> reports a stock shortfall, so the caller can answer 409 instead of 400.</summary>
    internal const string StockShortKey = "__stock";

    /// <summary>One priced line: its variant, quantity, unit price and line total.</summary>
    internal sealed record PricedLine(VariantRecord Record, VariantReference Variant, int Quantity, decimal Unit, Money Line);

    /// <summary>
    /// Looks up each SKU, checks it is on sale and in stock, and prices it in a currency. Adds an error keyed
    /// <c>{field}[i].sku</c> or <c>{field}[i].quantity</c> for each line that cannot be priced; stock shortfalls are
    /// reported as the first error so the caller can answer 409 where it needs to.
    /// </summary>
    internal static async Task<List<PricedLine>> PriceLinesAsync(StoreDbContext db, IReadOnlyList<(string Sku, int Quantity)> lines,
        Currency currency, Dictionary<string, string[]> errors, string field, Guid? forCustomer = null)
    {
        var skus = lines.Select(l => l.Sku).Distinct().ToList();
        var variants = await db.Variants.AsNoTracking().Where(v => skus.Contains(v.Sku)).ToDictionaryAsync(v => v.Sku);
        var ids = variants.Values.Select(v => v.Id).ToList();
        var productIds = variants.Values.Select(v => v.ProductId).Distinct().ToList();
        var onSale = (await db.Products.AsNoTracking().Where(p => productIds.Contains(p.Id) && p.Status == ProductStatus.Active).Select(p => p.Id).ToListAsync()).ToHashSet();
        var prices = await db.Prices.AsNoTracking().Where(p => ids.Contains(p.VariantId) && p.Currency == currency).ToDictionaryAsync(p => p.VariantId, p => p.Amount);
        var stock = await db.Stock.AsNoTracking().Where(s => ids.Contains(s.VariantId)).ToDictionaryAsync(s => s.VariantId, s => s.OnHand - s.Reserved);
        if (forCustomer is { } customerId)
        {
            // The customer's own cart holds count as available to them: those units are already theirs.
            var held = await db.Reservations.AsNoTracking().Where(r => r.CustomerId == customerId && r.Status == ReservationStatus.Held && ids.Contains(r.VariantId)).ToListAsync();
            foreach (var hold in held) stock[hold.VariantId] = stock.GetValueOrDefault(hold.VariantId) + hold.Quantity;
        }
        var names = await db.VariantReferencesAsync(ids);
        var priced = new List<PricedLine>();
        var seen = new HashSet<string>();
        for (var i = 0; i < lines.Count; i++)
        {
            var (sku, quantity) = lines[i];
            if (!seen.Add(sku)) errors[$"{field}[{i}].sku"] = ["List each SKU once and use its quantity."];
            else if (!variants.TryGetValue(sku, out var variant)) errors[$"{field}[{i}].sku"] = ["Choose an existing SKU."];
            else if (!onSale.Contains(variant.ProductId)) errors[$"{field}[{i}].sku"] = ["This product is not on sale."];
            else if (quantity < 1 || quantity > 20) errors[$"{field}[{i}].quantity"] = ["The quantity must be between 1 and 20."];
            else
            {
                var unit = prices[variant.Id];
                priced.Add(new PricedLine(variant, names[variant.Id], quantity, unit, EndpointSupport.ToMoney(unit * quantity, currency)));
            }
        }
        // Stock is checked last, so that bad input is always reported as 400 before a 409.
        if (errors.Count == 0)
        {
            var short_ = priced.FirstOrDefault(l => stock.GetValueOrDefault(l.Record.Id) < l.Quantity);
            if (short_ is not null) errors[StockShortKey] = [$"Only {stock.GetValueOrDefault(short_.Record.Id)} of {short_.Record.Sku} {(stock.GetValueOrDefault(short_.Record.Id) == 1 ? "is" : "are")} available; you asked for {short_.Quantity}."];
        }
        return priced;
    }

    /// <summary>Changes the stock held for a customer's cart line by <paramref name="change"/> units, creating or releasing the reservation.</summary>
    private static async Task HoldAsync(StoreDbContext db, Guid customerId, Guid variantId, StockRecord stock, int change)
    {
        var now = DateTimeOffset.UtcNow;
        var hold = await db.Reservations.SingleOrDefaultAsync(r => r.CustomerId == customerId && r.VariantId == variantId && r.Status == ReservationStatus.Held);
        if (hold is null && change > 0)
            db.Reservations.Add(new ReservationRecord
            {
                Id = Guid.NewGuid(), VariantId = variantId, CustomerId = customerId, Quantity = change, Status = ReservationStatus.Held,
                ExpiresAt = now.Add(HoldLifetime), CreatedAt = now
            });
        else if (hold is not null)
        {
            hold.Quantity += change;
            hold.ExpiresAt = now.Add(HoldLifetime);
            if (hold.Quantity <= 0) hold.Status = ReservationStatus.Released;
        }
        stock.Reserved = Math.Max(0, stock.Reserved + change);
        stock.UpdatedAt = now;
    }

    /// <summary>Maps a cart record to its priced contract. A cart with no record yet is shown empty.</summary>
    private static async Task<Cart> ToContractAsync(StoreDbContext db, CartRecord cart, CustomerRecord customer)
    {
        var items = await db.CartItems.AsNoTracking().Where(i => i.CartId == cart.Id).ToListAsync();
        var ids = items.Select(i => i.VariantId).ToList();
        var prices = await db.Prices.AsNoTracking().Where(p => ids.Contains(p.VariantId) && p.Currency == cart.Currency).ToDictionaryAsync(p => p.VariantId, p => p.Amount);
        var stock = await db.Stock.AsNoTracking().Where(s => ids.Contains(s.VariantId)).ToDictionaryAsync(s => s.VariantId);
        var names = await db.VariantReferencesAsync(ids);
        var lines = items.OrderBy(i => names[i.VariantId].Sku).Select(i => new CartItem
        {
            Id = i.Id, Variant = names[i.VariantId], Quantity = i.Quantity, UnitPrice = EndpointSupport.ToMoney(prices[i.VariantId], cart.Currency),
            LineTotal = EndpointSupport.ToMoney(prices[i.VariantId] * i.Quantity, cart.Currency),
            // This customer's own hold is part of "reserved", so add it back to show what they can still get.
            Available = stock[i.VariantId].OnHand - stock[i.VariantId].Reserved + i.Quantity
        }).ToList();
        var coupon = cart.CouponCode is null ? null : await db.Coupons.AsNoTracking().SingleOrDefaultAsync(c => c.Code == cart.CouponCode);
        var country = await db.Addresses.AsNoTracking().Where(a => a.CustomerId == customer.Id && a.Kind == AddressKind.Shipping)
            .OrderByDescending(a => a.IsDefault).Select(a => a.Country).FirstOrDefaultAsync() ?? "US";
        return new Cart
        {
            Id = cart.Id, Customer = customer.ToReference(), Currency = cart.Currency, CouponCode = cart.CouponCode, Items = lines,
            Totals = Pricing.Totals(lines.Sum(l => l.LineTotal.Value), coupon, ShippingSpeed.Standard, cart.Currency, customer.Tier, country),
            UpdatedAt = cart.UpdatedAt
        };
    }
}
