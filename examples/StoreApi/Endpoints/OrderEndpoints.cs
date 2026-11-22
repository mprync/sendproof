using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Sendproof.AspNetCore;
using System.Security.Claims;

namespace StoreApi;

/// <summary>The order operations: list and read orders, place one, cancel one and read its event history.</summary>
internal static class OrderEndpoints
{
    internal static void MapOrderEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v2/orders").WithTags("Orders");
        group.MapGet("/", List).WithName("OrdersController.List").RequireAuthorization()
            .WithMetadata(new SortKeysMetadata(SortKeys.Orders)).Produces<PagedList<OrderSummary>>().ProducesValidationProblem();
        group.MapGet("/{id:guid}", Get).WithName("OrdersController.Get").RequireAuthorization()
            .Produces<Order>().ProducesProblem(StatusCodes.Status403Forbidden).ProducesProblem(StatusCodes.Status404NotFound);
        group.MapPost("/", Place).WithName("OrdersController.Place").RequireAuthorization(Policies.Shoppers)
            .Produces<Order>(StatusCodes.Status201Created).Produces<Order>(StatusCodes.Status200OK).ProducesValidationProblem()
            .ProducesProblem(StatusCodes.Status402PaymentRequired).ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status409Conflict).ProducesProblem(StatusCodes.Status429TooManyRequests).WithSendproofPreview();
        group.MapPost("/{id:guid}/cancel", Cancel).WithName("OrdersController.Cancel").RequireAuthorization()
            .Produces<Order>().ProducesProblem(StatusCodes.Status403Forbidden).ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict).WithSendproofPreview();
        // The history lives in MongoDB, so its read exists only when the demo has that store.
        if (app.ServiceProvider.GetRequiredService<DemoStores>().HasMongo)
            group.MapGet("/{id:guid}/events", Events).WithName("OrdersController.Events").RequireAuthorization()
                .Produces<OrderTimeline>().ProducesProblem(StatusCodes.Status403Forbidden).ProducesProblem(StatusCodes.Status404NotFound);
    }

    /// <summary>List orders</summary>
    /// <remarks>
    /// Returns orders, newest first unless you pass `sort`. Staff see every order; a **customer sees only their own**.
    ///
    /// - Combine filters freely: `status=Paid&amp;currency=EUR` lists paid euro orders waiting for the warehouse.
    /// - `q` searches the order number and the customer's name and email.
    /// - Totals are in each order's own currency, so use `currency` before comparing `minTotal` and `maxTotal`.
    ///
    /// Open an order with `OrdersController.Get`; place one with `OrdersController.Place`.
    /// </remarks>
    /// <param name="page">The 1-based page number.</param>
    /// <param name="pageSize">How many orders to return per page, from 1 to 100.</param>
    /// <param name="status">Only orders in this status.</param>
    /// <param name="customerId">Only orders of this customer.</param>
    /// <param name="currency">Only orders in this currency.</param>
    /// <param name="placedFrom">Only orders placed on or after this date.</param>
    /// <param name="placedTo">Only orders placed on or before this date.</param>
    /// <param name="minTotal">Only orders of at least this total.</param>
    /// <param name="maxTotal">Only orders of at most this total.</param>
    /// <param name="q">Search text matched against the number and the customer's name and email.</param>
    /// <param name="sort">The sort order: a field name, with a leading minus for descending. Defaults to `-placedAt`.</param>
    /// <response code="200">A page of orders.</response>
    /// <response code="400">A paging, sort or filter value was invalid.</response>
    internal static async Task<IResult> List(StoreDbContext db, ClaimsPrincipal principal, int page = 1, int pageSize = EndpointSupport.DefaultPageSize,
        OrderStatus? status = null, Guid? customerId = null, Currency? currency = null, DateOnly? placedFrom = null, DateOnly? placedTo = null,
        decimal? minTotal = null, decimal? maxTotal = null, string? q = null, string? sort = null)
    {
        var errors = new Dictionary<string, string[]>();
        EndpointSupport.CheckPaging(page, pageSize, errors);
        EndpointSupport.CheckSort(sort, SortKeys.Orders, errors);
        EndpointSupport.CheckRange(placedFrom, placedTo, nameof(placedFrom), nameof(placedTo), errors);
        if (errors.Count > 0) return Results.ValidationProblem(errors);

        var query = db.Orders.AsNoTracking().AsQueryable();
        if (!principal.IsStaff())
        {
            var email = principal.Email();
            query = query.Where(o => db.Customers.Any(c => c.Id == o.CustomerId && c.Email == email));
        }
        if (status is { } s) query = query.Where(o => o.Status == s);
        if (customerId is { } cid) query = query.Where(o => o.CustomerId == cid);
        if (currency is { } cur) query = query.Where(o => o.Currency == cur);
        if (placedFrom is { } from) { var start = new DateTimeOffset(from.ToDateTime(TimeOnly.MinValue), TimeSpan.Zero); query = query.Where(o => o.PlacedAt >= start); }
        if (placedTo is { } to) { var end = new DateTimeOffset(to.AddDays(1).ToDateTime(TimeOnly.MinValue), TimeSpan.Zero); query = query.Where(o => o.PlacedAt < end); }
        if (minTotal is { } min) query = query.Where(o => o.Total >= min);
        if (maxTotal is { } max) query = query.Where(o => o.Total <= max);
        if (!string.IsNullOrWhiteSpace(q))
        {
            var pattern = EndpointSupport.LikePattern(q);
            query = query.Where(o => EF.Functions.Like(o.Number, pattern, "\\") || db.Customers.Any(c => c.Id == o.CustomerId &&
                (EF.Functions.Like(c.FirstName + " " + c.LastName, pattern, "\\") || EF.Functions.Like(c.Email, pattern, "\\"))));
        }
        var ordered = (sort ?? "-placedAt") switch
        {
            "placedAt" => EndpointSupport.Sorted(query, false, o => o.PlacedAt, o => o.Id),
            "total" => EndpointSupport.Sorted(query, false, o => o.Total, o => o.Id),
            "-total" => EndpointSupport.Sorted(query, true, o => o.Total, o => o.Id),
            "number" => EndpointSupport.Sorted(query, false, o => o.Number, o => o.Id),
            "-number" => EndpointSupport.Sorted(query, true, o => o.Number, o => o.Id),
            _ => EndpointSupport.Sorted(query, true, o => o.PlacedAt, o => o.Id)
        };
        return TypedResults.Ok(await EndpointSupport.PageAsync(ordered, page, pageSize, async rows => await rows.ToSummariesAsync(db)));
    }

    /// <summary>Get order</summary>
    /// <remarks>Returns one order with its lines as they were priced, totals, delivery address, payment and shipments. A customer can read only their own orders.</remarks>
    /// <param name="id">The order's ID, from `OrdersController.List` or the response of `OrdersController.Place`.</param>
    /// <response code="200">The order.</response>
    /// <response code="403">You are a customer and this is somebody else's order.</response>
    /// <response code="404">No order has this ID.</response>
    internal static async Task<IResult> Get(Guid id, StoreDbContext db, ClaimsPrincipal principal)
    {
        var order = await db.Orders.AsNoTracking().SingleOrDefaultAsync(o => o.Id == id);
        if (order is null) return EndpointSupport.NotFound("order", id);
        var customer = await db.Customers.AsNoTracking().SingleAsync(c => c.Id == order.CustomerId);
        return principal.CanActFor(customer) ? TypedResults.Ok(await order.ToContractAsync(db)) : EndpointSupport.Forbidden(EndpointSupport.NotYours);
    }

    /// <summary>Place order</summary>
    /// <remarks>
    /// Turns a basket into an order, charges the payment method and tells the warehouse. In one request it:
    ///
    /// 1. **Checks** the rate limit (Redis `ratelimit:orders:{email}`: 10 orders an hour), the idempotency key (SQL and DynamoDB) and, when you pass `quoteId`, the cached quote (Redis).
    /// 2. **Prices** every line in `currency`, applies the coupon, shipping and tax, and checks stock.
    /// 3. **Writes** the order, its lines, the payment, the stock movements and the reservations to SQL, and the order's event history to MongoDB.
    /// 4. **Holds back** the confirmation email, the fulfilment webhook, the pick-list job and the `store.orders.placed` message until a Send.
    ///
    /// Send an `Idempotency-Key` header to make retries safe: repeating the same request with the same key returns the original order with status 200, and
    /// reusing the key with a different body fails with 409. The payment is a union chosen by `payment.type`: `Card`, `BankTransfer` or `GiftCard`. A card
    /// token ending in `_0002` is declined with 402.
    ///
    /// Preview runs all of it for real inside a transaction, shows the changes grouped by store (SQL rows, MongoDB documents) and the Redis and DynamoDB reads, and
    /// rolls everything back. Reads of Redis and DynamoDB are allowed in a Preview; their writes happen on Send only.
    /// </remarks>
    /// <param name="request">The order to place.</param>
    /// <param name="idempotencyKey">A unique key for this request, up to 128 characters. Generate a UUID for each new order.</param>
    /// <response code="201">The order was placed. The `Location` header points to it.</response>
    /// <response code="200">The idempotency key was used before with the same request; the original order is returned.</response>
    /// <response code="400">A field was missing or invalid. The `errors` object names each one, such as `items[0].sku` or `payment.token`.</response>
    /// <response code="402">The payment method was declined. Nothing was changed.</response>
    /// <response code="403">You are a customer and tried to order for somebody else.</response>
    /// <response code="409">The idempotency key was used for a different request, a line is out of stock, or the quoted price moved.</response>
    /// <response code="429">The customer already placed 10 orders this hour.</response>
    internal static async Task<IResult> Place(PlaceOrderRequest request, [FromHeader(Name = "Idempotency-Key")] string? idempotencyKey,
        StoreDbContext db, ClaimsPrincipal principal, DemoStores stores, DemoNotificationQueue notifications, SendproofPreview preview)
    {
        var errors = EndpointSupport.Validate(request);
        if (idempotencyKey?.Length > 128) errors["Idempotency-Key"] = ["The idempotency key must be at most 128 characters."];
        var currency = EndpointSupport.ParseCurrency(request.Currency);
        if (currency is null) errors["currency"] = [$"Use one of: {EndpointSupport.CurrencyNames}."];
        var speed = EndpointSupport.ParseSpeed(request.ShippingSpeed);
        if (speed is null) errors["shippingSpeed"] = ["Use Standard, Express or Next day."];
        var customer = await db.Customers.SingleOrDefaultAsync(c => c.Id == request.CustomerId);
        if (customer is null) errors["customerId"] = ["Choose an existing customer."];
        if (errors.Count > 0) return Results.ValidationProblem(errors);
        if (!principal.CanActFor(customer!)) return EndpointSupport.Forbidden("Customers can only place orders for themselves.");

        // Idempotency: SQL is the record of truth; DynamoDB remembers keys across restarts of the order store.
        var requestHash = Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(request)));
        if (!string.IsNullOrWhiteSpace(idempotencyKey))
        {
            var existing = await db.Orders.AsNoTracking().SingleOrDefaultAsync(o => o.IdempotencyKey == idempotencyKey);
            if (existing is not null)
                return existing.RequestHash == requestHash ? TypedResults.Ok(await existing.ToContractAsync(db))
                    : EndpointSupport.Conflict("Idempotency key was already used for a different request.");
            if (await stores.ReadIdempotencyAsync(idempotencyKey) is { } remembered && remembered != requestHash)
                return EndpointSupport.Conflict("Idempotency key was already used for a different request.");
        }

        if (await stores.OrdersThisHourAsync(customer!.Email) >= DemoStores.OrdersPerHour)
            return Results.Problem(title: "Too many orders", detail: $"{customer.Email} already placed {DemoStores.OrdersPerHour} orders this hour. Try again later.",
                statusCode: StatusCodes.Status429TooManyRequests);

        var priced = await CartEndpoints.PriceLinesAsync(db, request.Items.Select(i => (i.Sku, i.Quantity)).ToList(), currency!.Value, errors, "items", customer.Id);
        if (errors.Remove(CartEndpoints.StockShortKey, out var shortage) && errors.Count == 0) return EndpointSupport.Conflict(shortage[0]);
        CouponRecord? coupon = null;
        if (!string.IsNullOrWhiteSpace(request.CouponCode))
        {
            coupon = await db.Coupons.SingleOrDefaultAsync(c => c.Code == request.CouponCode);
            var problem = coupon is null ? "No such coupon." : Pricing.CouponProblem(coupon, priced?.Sum(l => l.Line.Value) ?? 0, currency.Value, DateOnly.FromDateTime(DateTime.UtcNow));
            if (problem is not null) errors["couponCode"] = [problem];
        }
        if (errors.Count > 0) return Results.ValidationProblem(errors);

        var totals = Pricing.Totals(priced!.Sum(l => l.Line.Value), coupon, speed!.Value, currency.Value, customer.Tier, request.ShippingAddress.Country);
        if (request.QuoteId is { Length: > 0 } quoteId && stores.HasRedis)
        {
            var quote = await stores.ReadQuoteAsync(quoteId);
            if (quote is null) return EndpointSupport.Conflict($"Quote {quoteId} has expired or does not exist. Ask for a new quote.");
            if (quote.Totals.Total.Value != totals.Total.Value || quote.Totals.Total.Currency != totals.Total.Currency)
                return EndpointSupport.Conflict($"The price moved since the quote: it was {quote.Totals.Total.Value:N2} {quote.Totals.Total.Currency}, it is now {totals.Total.Value:N2} {totals.Total.Currency}. Ask for a new quote.");
        }

        var method = request.Payment!;
        if (method is CardPayment card && card.Token.EndsWith("_0002", StringComparison.Ordinal))
            return Results.Problem(title: "Payment declined", detail: $"{method.Display} was declined by the card issuer. Try another payment method.",
                statusCode: StatusCodes.Status402PaymentRequired);

        var now = DateTimeOffset.UtcNow;
        var order = new OrderRecord
        {
            Id = Guid.NewGuid(), Number = await NextNumberAsync(db), CustomerId = customer.Id,
            Status = method.Kind == PaymentMethodKind.BankTransfer ? OrderStatus.Pending : OrderStatus.Paid, Currency = currency.Value,
            Subtotal = totals.Subtotal.Value, Discount = totals.Discount.Value, ShippingCost = totals.Shipping.Value, Tax = totals.Tax.Value, Total = totals.Total.Value,
            CouponCode = coupon?.Code, ShippingSpeed = speed.Value, ShipToName = request.ShippingAddress.Recipient, ShipToLine1 = request.ShippingAddress.Line1,
            ShipToLine2 = request.ShippingAddress.Line2, ShipToCity = request.ShippingAddress.City, ShipToRegion = request.ShippingAddress.Region,
            ShipToPostalCode = request.ShippingAddress.PostalCode, ShipToCountry = request.ShippingAddress.Country, Note = request.Note,
            PlacedBy = principal.Email(), IdempotencyKey = string.IsNullOrWhiteSpace(idempotencyKey) ? null : idempotencyKey, RequestHash = requestHash,
            PlacedAt = now, UpdatedAt = now
        };
        db.Orders.Add(order);
        var lowStock = new List<(string Sku, int Available)>();
        foreach (var line in priced)
        {
            db.OrderLines.Add(new OrderLineRecord
            {
                Id = Guid.NewGuid(), OrderId = order.Id, VariantId = line.Record.Id, Sku = line.Record.Sku, Name = line.Variant.Name,
                Quantity = line.Quantity, UnitPrice = line.Unit, LineTotal = line.Line.Value
            });
            var stock = await db.Stock.SingleAsync(s => s.VariantId == line.Record.Id);
            // The customer's own cart hold turns into the order's committed reservation.
            var hold = await db.Reservations.SingleOrDefaultAsync(r => r.CustomerId == customer.Id && r.VariantId == line.Record.Id && r.Status == ReservationStatus.Held);
            if (hold is not null)
            {
                stock.Reserved = Math.Max(0, stock.Reserved - hold.Quantity);
                hold.Status = ReservationStatus.Released;
            }
            stock.OnHand -= line.Quantity;
            stock.UpdatedAt = now;
            db.StockMovements.Add(new StockMovementRecord
            {
                Id = Guid.NewGuid(), VariantId = line.Record.Id, Delta = -line.Quantity, Reason = StockReason.Sold, Reference = order.Number,
                Actor = principal.Email(), CreatedAt = now
            });
            db.Reservations.Add(new ReservationRecord
            {
                Id = Guid.NewGuid(), VariantId = line.Record.Id, Quantity = line.Quantity, OrderId = order.Id, CustomerId = customer.Id,
                Status = ReservationStatus.Committed, ExpiresAt = now, CreatedAt = now
            });
            if (stock.OnHand - stock.Reserved <= stock.ReorderPoint) lowStock.Add((line.Record.Sku, stock.OnHand - stock.Reserved));
        }
        var purchased = priced.Select(l => l.Record.Id).ToList();
        var cart = await db.Carts.SingleOrDefaultAsync(c => c.CustomerId == customer.Id);
        if (cart is not null)
            db.CartItems.RemoveRange(await db.CartItems.Where(i => i.CartId == cart.Id && purchased.Contains(i.VariantId)).ToListAsync());
        db.Payments.Add(new PaymentRecord
        {
            Id = Guid.NewGuid(), OrderId = order.Id, Method = method.Kind, Status = method.Kind == PaymentMethodKind.BankTransfer ? PaymentStatus.Authorized : PaymentStatus.Captured,
            Amount = order.Total, Currency = order.Currency, MethodDisplay = method.Display, ProviderReference = $"pay_{Guid.NewGuid():N}"[..20], CreatedAt = now
        });
        if (coupon is not null) coupon.Redeemed++;
        db.Audit("Order", order.Id, "Order.Placed", order.PlacedBy);
        await db.SaveChangesAsync();

        var actor = new ActorReference { Email = principal.Email(), Name = principal.DisplayName() };
        await stores.RecordOrderEventsAsync(order.Id, order.Number, order.Status.ToString(), actor,
        [
            ("Order.Placed", now, $"Order {order.Number} placed for {order.Total:N2} {order.Currency}."),
            (method.Kind == PaymentMethodKind.BankTransfer ? "Payment.Authorized" : "Payment.Captured", now.AddSeconds(2), $"{method.Display} accepted.")
        ]);
        // DynamoDB and Redis writes cannot be rolled back, so a Preview skips them: it only reads those stores.
        if (!preview.IsActive)
        {
            if (order.IdempotencyKey is not null) await stores.RememberIdempotencyAsync(order.IdempotencyKey, requestHash, order.Id);
            await stores.CountOrderAsync(customer.Email);
        }
        notifications.OrderPlaced(order, customer.Email, priced.Sum(l => l.Quantity), preview);
        foreach (var (sku, available) in lowStock) notifications.StockLow(sku, available, preview);
        return TypedResults.Created($"/api/v2/orders/{order.Id}", await order.ToContractAsync(db));
    }

    /// <summary>Cancel order</summary>
    /// <remarks>
    /// Cancels an order that has **not shipped yet** (`Pending`, `Paid` or `Processing`). The stock goes back on the shelf, a captured payment is
    /// refunded in full, the customer is emailed, and the fulfilment partner is told. A customer can cancel only their own orders.
    ///
    /// The body is **optional**: send `{ "reason": "..." }` to keep a reason on the order, or send nothing.
    /// </remarks>
    /// <param name="id">The order's ID.</param>
    /// <param name="request">An optional reason, kept on the order and in its history.</param>
    /// <response code="200">The cancelled order.</response>
    /// <response code="403">You are a customer and this is somebody else's order.</response>
    /// <response code="404">No order has this ID.</response>
    /// <response code="409">The order already shipped, was delivered or is already cancelled.</response>
    internal static async Task<IResult> Cancel(Guid id, StoreDbContext db, ClaimsPrincipal principal, DemoStores stores,
        DemoNotificationQueue notifications, SendproofPreview preview, [FromBody] CancelOrderRequest? request = null)
    {
        var order = await db.Orders.SingleOrDefaultAsync(o => o.Id == id);
        if (order is null) return EndpointSupport.NotFound("order", id);
        var customer = await db.Customers.AsNoTracking().SingleAsync(c => c.Id == order.CustomerId);
        if (!principal.CanActFor(customer)) return EndpointSupport.Forbidden(EndpointSupport.NotYours);
        if (order.Status is not (OrderStatus.Pending or OrderStatus.Paid or OrderStatus.Processing))
            return EndpointSupport.Conflict($"A {order.Status} order cannot be cancelled.");

        var now = DateTimeOffset.UtcNow;
        order.Status = OrderStatus.Cancelled;
        order.CancelReason = string.IsNullOrWhiteSpace(request?.Reason) ? null : request.Reason;
        order.UpdatedAt = now;
        foreach (var line in await db.OrderLines.Where(l => l.OrderId == id).ToListAsync())
        {
            var stock = await db.Stock.SingleAsync(s => s.VariantId == line.VariantId);
            stock.OnHand += line.Quantity;
            stock.UpdatedAt = now;
            db.StockMovements.Add(new StockMovementRecord
            {
                Id = Guid.NewGuid(), VariantId = line.VariantId, Delta = line.Quantity, Reason = StockReason.Returned, Reference = order.Number,
                Actor = principal.Email(), CreatedAt = now
            });
        }
        foreach (var reservation in await db.Reservations.Where(r => r.OrderId == id && r.Status == ReservationStatus.Committed).ToListAsync())
            reservation.Status = ReservationStatus.Released;
        var payment = await db.Payments.FirstOrDefaultAsync(p => p.OrderId == id);
        if (payment is not null)
        {
            if (payment.Status == PaymentStatus.Captured)
            {
                payment.Status = PaymentStatus.Refunded;
                payment.RefundedAmount = payment.Amount;
                db.Refunds.Add(new RefundRecord
                {
                    Id = Guid.NewGuid(), PaymentId = payment.Id, Amount = payment.Amount, Currency = payment.Currency, Reason = RefundReason.CustomerRequest,
                    Note = "Order cancelled", CreatedBy = principal.Email(), CreatedAt = now
                });
            }
            else
            {
                payment.Status = PaymentStatus.Failed;
                payment.FailureReason = "The order was cancelled before the payment was captured.";
            }
        }
        db.Audit("Order", order.Id, order.CancelReason is null ? "Order.Cancelled" : $"Order.Cancelled: {order.CancelReason}", principal.Email());
        await db.SaveChangesAsync();
        await stores.RecordOrderEventsAsync(order.Id, order.Number, order.Status.ToString(),
            new ActorReference { Email = principal.Email(), Name = principal.DisplayName() },
            [("Order.Cancelled", now, $"Cancelled: {order.CancelReason ?? "no reason given"}.")]);
        notifications.OrderCancelled(order, customer.Email, preview);
        return TypedResults.Ok(await order.ToContractAsync(db));
    }

    /// <summary>List order events</summary>
    /// <remarks>
    /// Returns the order's history from MongoDB: one document per order holding every event in a nested array, oldest first (placed, payment
    /// captured, shipped, delivered, cancelled). Available only when the demo runs with MongoDB (`DemoMongoUrl`).
    /// </remarks>
    /// <param name="id">The order's ID.</param>
    /// <response code="200">The order's history.</response>
    /// <response code="403">You are a customer and this is somebody else's order.</response>
    /// <response code="404">No order has this ID, or it has no history yet.</response>
    internal static async Task<IResult> Events(Guid id, StoreDbContext db, ClaimsPrincipal principal, DemoStores stores)
    {
        var order = await db.Orders.AsNoTracking().SingleOrDefaultAsync(o => o.Id == id);
        if (order is null) return EndpointSupport.NotFound("order", id);
        var customer = await db.Customers.AsNoTracking().SingleAsync(c => c.Id == order.CustomerId);
        if (!principal.CanActFor(customer)) return EndpointSupport.Forbidden(EndpointSupport.NotYours);
        var document = await stores.TimelineAsync(id);
        if (document is null) return EndpointSupport.NotFound("event history for order", id);
        return TypedResults.Ok(new OrderTimeline
        {
            OrderId = id, Number = document["number"].AsString, UpdatedAt = new DateTimeOffset(document["updatedAt"].ToUniversalTime()),
            Events = document["events"].AsBsonArray.Select(e => e.AsBsonDocument).Select(e => new OrderEvent
            {
                Type = e["type"].AsString, At = new DateTimeOffset(e["at"].ToUniversalTime()), Status = e["status"].AsString, Summary = e["summary"].AsString,
                Actor = new ActorReference { Email = e["actor"]["email"].AsString, Name = e["actor"]["name"].AsString }
            }).ToList()
        });
    }

    /// <summary>Allocates the next order number of the current year, such as <c>AS-2026-004512</c>.</summary>
    internal static async Task<string> NextNumberAsync(StoreDbContext db)
    {
        var prefix = $"AS-{DateTime.UtcNow.Year}-";
        var last = await db.Orders.AsNoTracking().Where(o => o.Number.StartsWith(prefix)).OrderByDescending(o => o.Number).Select(o => o.Number).FirstOrDefaultAsync();
        return $"{prefix}{(last is null ? 4500 : int.Parse(last[prefix.Length..]) + 1):000000}";
    }
}
