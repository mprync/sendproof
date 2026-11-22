using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using Sendproof.AspNetCore;

namespace StoreApi;

/// <summary>The payment operations: list and read payments, and refund them.</summary>
internal static class PaymentEndpoints
{
    internal static void MapPaymentEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v2/payments").WithTags("Payments");
        group.MapGet("/", List).WithName("PaymentsController.List").RequireAuthorization(Policies.Support)
            .WithMetadata(new SortKeysMetadata(SortKeys.Payments)).Produces<PagedList<Payment>>().ProducesValidationProblem();
        group.MapGet("/{id:guid}", Get).WithName("PaymentsController.Get").RequireAuthorization(Policies.Support)
            .Produces<Payment>().ProducesProblem(StatusCodes.Status404NotFound);
        group.MapPost("/{id:guid}/refunds", Refund).WithName("PaymentsController.Refund").RequireAuthorization(Policies.Support)
            .Produces<Payment>(StatusCodes.Status201Created).ProducesValidationProblem().ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict).ProducesProblem(StatusCodes.Status422UnprocessableEntity).WithSendproofPreview();
    }

    /// <summary>List payments</summary>
    /// <remarks>
    /// Returns the payments taken for orders, newest first unless you pass `sort`. Requires the `admin` or `support` role.
    ///
    /// - `status=PartiallyRefunded` lists payments that still have something left to refund.
    /// - Amounts are in each payment's own currency; combine `currency` with `minAmount` and `maxAmount`.
    /// </remarks>
    /// <param name="page">The 1-based page number.</param>
    /// <param name="pageSize">How many payments to return per page, from 1 to 100.</param>
    /// <param name="status">Only payments in this status.</param>
    /// <param name="method">Only payments made this way.</param>
    /// <param name="orderId">Only the payments of this order.</param>
    /// <param name="currency">Only payments in this currency.</param>
    /// <param name="minAmount">Only payments of at least this amount.</param>
    /// <param name="maxAmount">Only payments of at most this amount.</param>
    /// <param name="sort">The sort order: a field name, with a leading minus for descending. Defaults to `-createdAt`.</param>
    /// <response code="200">A page of payments.</response>
    /// <response code="400">A paging, sort or filter value was invalid.</response>
    internal static async Task<IResult> List(StoreDbContext db, int page = 1, int pageSize = EndpointSupport.DefaultPageSize,
        PaymentStatus? status = null, PaymentMethodKind? method = null, Guid? orderId = null, Currency? currency = null,
        decimal? minAmount = null, decimal? maxAmount = null, string? sort = null)
    {
        var errors = new Dictionary<string, string[]>();
        EndpointSupport.CheckPaging(page, pageSize, errors);
        EndpointSupport.CheckSort(sort, SortKeys.Payments, errors);
        if (errors.Count > 0) return Results.ValidationProblem(errors);
        var query = db.Payments.AsNoTracking().AsQueryable();
        if (status is { } s) query = query.Where(p => p.Status == s);
        if (method is { } m) query = query.Where(p => p.Method == m);
        if (orderId is { } o) query = query.Where(p => p.OrderId == o);
        if (currency is { } c) query = query.Where(p => p.Currency == c);
        if (minAmount is { } min) query = query.Where(p => p.Amount >= min);
        if (maxAmount is { } max) query = query.Where(p => p.Amount <= max);
        var ordered = (sort ?? "-createdAt") switch
        {
            "createdAt" => EndpointSupport.Sorted(query, false, p => p.CreatedAt, p => p.Id),
            "amount" => EndpointSupport.Sorted(query, false, p => p.Amount, p => p.Id),
            "-amount" => EndpointSupport.Sorted(query, true, p => p.Amount, p => p.Id),
            _ => EndpointSupport.Sorted(query, true, p => p.CreatedAt, p => p.Id)
        };
        return TypedResults.Ok(await EndpointSupport.PageAsync(ordered, page, pageSize, async rows => await rows.ToContractsAsync(db)));
    }

    /// <summary>Get payment</summary>
    /// <remarks>Returns one payment with how much was refunded and each refund. Requires the `admin` or `support` role.</remarks>
    /// <param name="id">The payment's ID, from `PaymentsController.List` or an order's `payment`.</param>
    /// <response code="200">The payment.</response>
    /// <response code="404">No payment has this ID.</response>
    internal static async Task<IResult> Get(Guid id, StoreDbContext db) =>
        await db.Payments.AsNoTracking().SingleOrDefaultAsync(p => p.Id == id) is { } payment
            ? TypedResults.Ok(await payment.ToContractAsync(db)) : EndpointSupport.NotFound("payment", id);

    /// <summary>Refund payment</summary>
    /// <remarks>
    /// Gives part or all of a payment back to the customer. The amount is in the payment's own currency and cannot exceed what is left to refund.
    /// A payment that is fully refunded moves to `Refunded`, and its order does too once it was delivered. The customer is emailed and the refund
    /// is published to the accounting system.
    ///
    /// Only captured payments can be refunded (409 otherwise). Asking for more than what is left is a business-rule violation (422).
    /// Requires the `admin` or `support` role.
    /// </remarks>
    /// <param name="id">The payment's ID.</param>
    /// <param name="request">The amount, currency and reason.</param>
    /// <response code="201">The refund was made. The response is the payment with the refund added.</response>
    /// <response code="400">A field was missing or invalid, such as a currency that differs from the payment's.</response>
    /// <response code="404">No payment has this ID.</response>
    /// <response code="409">The payment was not captured, or is already fully refunded.</response>
    /// <response code="422">The amount is more than what is left to refund.</response>
    internal static async Task<IResult> Refund(Guid id, RefundRequest request, StoreDbContext db, ClaimsPrincipal principal,
        DemoStores stores, DemoNotificationQueue notifications, SendproofPreview preview)
    {
        var payment = await db.Payments.SingleOrDefaultAsync(p => p.Id == id);
        if (payment is null) return EndpointSupport.NotFound("payment", id);
        var errors = EndpointSupport.Validate(request);
        var currency = EndpointSupport.ParseCurrency(request.Currency);
        if (currency is null) errors["currency"] = [$"Use one of: {EndpointSupport.CurrencyNames}."];
        else if (currency != payment.Currency) errors["currency"] = [$"Currency must match the payment's currency, {payment.Currency}."];
        if (request.Amount < 0.01m) errors["amount"] = ["Amount must be at least 0.01."];
        else if (currency is not null && EndpointSupport.HasTooManyDecimals(request.Amount, currency.Value))
            errors["amount"] = [$"{currency} amounts allow at most {EndpointSupport.Decimals(currency.Value)} decimal places."];
        if (!TryParseReason(request.Reason, out var reason)) errors["reason"] = ["Use Damaged, Wrong item, Not as described, Customer request or Other."];
        if (errors.Count > 0) return Results.ValidationProblem(errors);
        if (payment.Status is not (PaymentStatus.Captured or PaymentStatus.PartiallyRefunded))
            return EndpointSupport.Conflict($"Only captured payments can be refunded; this one is {payment.Status}.");
        var left = payment.Amount - payment.RefundedAmount;
        if (request.Amount > left)
            return EndpointSupport.Unprocessable($"Only {left:N2} {payment.Currency} is left to refund; you asked for {request.Amount:N2}.");

        var now = DateTimeOffset.UtcNow;
        var refund = new RefundRecord
        {
            Id = Guid.NewGuid(), PaymentId = id, Amount = request.Amount, Currency = payment.Currency, Reason = reason, Note = request.Note,
            CreatedBy = principal.Email(), CreatedAt = now
        };
        db.Refunds.Add(refund);
        payment.RefundedAmount += request.Amount;
        payment.Status = payment.RefundedAmount >= payment.Amount ? PaymentStatus.Refunded : PaymentStatus.PartiallyRefunded;
        var order = await db.Orders.SingleAsync(o => o.Id == payment.OrderId);
        if (payment.Status == PaymentStatus.Refunded && order.Status == OrderStatus.Delivered) order.Status = OrderStatus.Refunded;
        order.UpdatedAt = now;
        db.Audit("Payment", id, $"Payment.Refunded: {request.Amount:N2} {payment.Currency}", principal.Email());
        await db.SaveChangesAsync();
        await stores.RecordOrderEventsAsync(order.Id, order.Number, order.Status.ToString(),
            new ActorReference { Email = principal.Email(), Name = principal.DisplayName() },
            [("Payment.Refunded", now, $"Refunded {request.Amount:N2} {payment.Currency}: {reason}.")]);
        var customer = await db.Customers.AsNoTracking().SingleAsync(c => c.Id == order.CustomerId);
        notifications.RefundIssued(order, refund, customer.Email, preview);
        return TypedResults.Created($"/api/v2/payments/{id}", await payment.ToContractAsync(db));
    }

    /// <summary>Parses a refund reason spelled as the API sends it, such as <c>Wrong item</c>.</summary>
    private static bool TryParseReason(string? text, out RefundReason reason)
    {
        reason = text switch
        {
            "Damaged" => RefundReason.Damaged, "Wrong item" => RefundReason.WrongItem, "Not as described" => RefundReason.NotAsDescribed,
            "Customer request" => RefundReason.CustomerRequest, "Other" => RefundReason.Other, _ => (RefundReason)(-1)
        };
        return Enum.IsDefined(reason);
    }
}
