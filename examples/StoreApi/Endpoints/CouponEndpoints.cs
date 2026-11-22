using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using Sendproof.AspNetCore;

namespace StoreApi;

/// <summary>The coupon operations: list coupons, check whether one applies to a basket, and create one.</summary>
internal static class CouponEndpoints
{
    internal static void MapCouponEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v2/coupons").WithTags("Coupons");
        group.MapGet("/", List).WithName("CouponsController.List").RequireAuthorization(Policies.Support)
            .WithMetadata(new SortKeysMetadata(SortKeys.Coupons)).Produces<PagedList<Coupon>>().ProducesValidationProblem();
        group.MapGet("/{code}/check", Check).WithName("CouponsController.Check").RequireAuthorization()
            .Produces<CouponCheck>().ProducesValidationProblem();
        group.MapPost("/{code}/redemptions", Redeem).WithName("CouponsController.Redeem").RequireAuthorization(Policies.Support)
            .Produces<CouponRedemption>().ProducesValidationProblem().ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict).WithSendproofPreview();
        group.MapPost("/", Create).WithName("CouponsController.Create").RequireAuthorization(Policies.Admins)
            .Produces<Coupon>(StatusCodes.Status201Created).ProducesValidationProblem().ProducesProblem(StatusCodes.Status409Conflict)
            .WithSendproofPreview();
    }

    /// <summary>List coupons</summary>
    /// <remarks>
    /// Returns discount codes with how often each was used. Every item has a `kind` of `Percentage`, `FixedAmount` or `FreeShipping`; percentage coupons carry `percentOff`
    /// and fixed-amount ones `amountOff` and `currency`. Requires the `admin` or `support` role.
    /// </remarks>
    /// <param name="page">The 1-based page number.</param>
    /// <param name="pageSize">How many coupons to return per page, from 1 to 100.</param>
    /// <param name="kind">Only coupons of this kind.</param>
    /// <param name="isActive">Only coupons that are switched on (`true`) or off (`false`).</param>
    /// <param name="q">Search text matched against the code and description.</param>
    /// <param name="sort">The sort order: a field name, with a leading minus for descending. Defaults to `code`.</param>
    /// <response code="200">A page of coupons.</response>
    /// <response code="400">A paging or sort value was invalid.</response>
    internal static async Task<IResult> List(StoreDbContext db, int page = 1, int pageSize = EndpointSupport.DefaultPageSize,
        CouponKind? kind = null, bool? isActive = null, string? q = null, string? sort = null)
    {
        var errors = new Dictionary<string, string[]>();
        EndpointSupport.CheckPaging(page, pageSize, errors);
        EndpointSupport.CheckSort(sort, SortKeys.Coupons, errors);
        if (errors.Count > 0) return Results.ValidationProblem(errors);
        var query = db.Coupons.AsNoTracking().AsQueryable();
        if (kind is { } k) query = query.Where(c => c.Kind == k);
        if (isActive is { } active) query = query.Where(c => c.IsActive == active);
        if (!string.IsNullOrWhiteSpace(q))
        {
            var pattern = EndpointSupport.LikePattern(q);
            query = query.Where(c => EF.Functions.Like(c.Code, pattern, "\\") || EF.Functions.Like(c.Description, pattern, "\\"));
        }
        var ordered = (sort ?? "code") switch
        {
            "-code" => EndpointSupport.Sorted(query, true, c => c.Code, c => c.Id),
            "expiresOn" => EndpointSupport.Sorted(query, false, c => c.ExpiresOn, c => c.Id),
            "-expiresOn" => EndpointSupport.Sorted(query, true, c => c.ExpiresOn, c => c.Id),
            _ => EndpointSupport.Sorted(query, false, c => c.Code, c => c.Id)
        };
        return TypedResults.Ok(await EndpointSupport.PageAsync(ordered, page, pageSize,
            rows => Task.FromResult<IReadOnlyList<Coupon>>(rows.Select(c => c.ToContract()).ToList())));
    }

    /// <summary>Check coupon</summary>
    /// <remarks>
    /// A **read-only** check of whether a code applies to a basket, and what it would take off. Nothing is created or counted: use it
    /// while the shopper types the code, before `OrdersController.Place`. An unknown or unusable code is not an error; it answers `valid: false`
    /// with a `reason`.
    /// </remarks>
    /// <param name="code">The code to check, such as `SPRING15`.</param>
    /// <param name="subtotal">The basket's subtotal, in `currency`.</param>
    /// <param name="currency">The currency of the basket.</param>
    /// <response code="200">Whether the coupon applies, with its discount or the reason it does not.</response>
    /// <response code="400">The subtotal was negative.</response>
    internal static async Task<IResult> Check(string code, StoreDbContext db, decimal subtotal = 0m, Currency currency = Currency.USD)
    {
        if (subtotal < 0) return Results.ValidationProblem(new Dictionary<string, string[]> { ["subtotal"] = ["The subtotal cannot be negative."] });
        var coupon = await db.Coupons.AsNoTracking().SingleOrDefaultAsync(c => c.Code == code.ToUpperInvariant());
        var problem = coupon is null ? "No such coupon." : Pricing.CouponProblem(coupon, subtotal, currency, DateOnly.FromDateTime(DateTime.UtcNow));
        return TypedResults.Ok(new CouponCheck
        {
            Code = code.ToUpperInvariant(), Valid = problem is null, Reason = problem,
            Discount = problem is null ? EndpointSupport.ToMoney(Pricing.Discount(coupon, subtotal, currency), currency) : null
        });
    }

    /// <summary>Redeem coupon</summary>
    /// <remarks>
    /// Counts redemptions against a coupon, for example when a partner system reports orders that used it. With Redis configured the
    /// count is kept with `INCRBY coupon:redemptions:{code}` and then copied to the coupon in SQL.
    ///
    /// **This operation cannot be previewed.** `INCRBY` is a Redis write that cannot be rolled back, so Sendproof's write guard stops a
    /// Preview before it is sent and answers 409 with "Preview stopped before writing to Redis". Send it to count for real. Without
    /// Redis the count is kept in SQL only, and a Preview works. Requires the `admin` or `support` role.
    /// </remarks>
    /// <param name="code">The coupon's code, from `CouponsController.List`.</param>
    /// <param name="request">How many redemptions to count.</param>
    /// <response code="200">The redemption count after the change.</response>
    /// <response code="400">The count was outside 1 to 50.</response>
    /// <response code="404">No coupon has this code.</response>
    /// <response code="409">The coupon is switched off or would exceed its maximum redemptions.</response>
    internal static async Task<IResult> Redeem(string code, RedeemCouponRequest request, StoreDbContext db, ClaimsPrincipal principal, DemoStores stores)
    {
        var errors = EndpointSupport.Validate(request);
        if (errors.Count > 0) return Results.ValidationProblem(errors);
        var coupon = await db.Coupons.SingleOrDefaultAsync(c => c.Code == code.ToUpperInvariant());
        if (coupon is null) return EndpointSupport.NotFound("coupon", code);
        if (!coupon.IsActive) return EndpointSupport.Conflict($"Coupon {coupon.Code} is switched off.");
        if (coupon.MaxRedemptions is { } max && coupon.Redeemed + request.Count > max)
            return EndpointSupport.Conflict($"Coupon {coupon.Code} has {max - coupon.Redeemed} redemptions left; you asked for {request.Count}.");
        // The Redis counter is the count of record when it exists; INCRBY is the write a Preview cannot make.
        var total = await stores.CountRedemptionsAsync(coupon.Code, request.Count);
        coupon.Redeemed = total is { } counted ? (int)counted : coupon.Redeemed + request.Count;
        db.Audit("Coupon", coupon.Id, $"Coupon.Redeemed: +{request.Count}", principal.Email());
        await db.SaveChangesAsync();
        return TypedResults.Ok(new CouponRedemption { Code = coupon.Code, Redeemed = coupon.Redeemed, Remaining = coupon.MaxRedemptions - coupon.Redeemed });
    }

    /// <summary>Create coupon</summary>
    /// <remarks>
    /// Adds a discount code. The body is a **union** chosen by `kind`:
    ///
    /// | `kind` | Also needs | Takes off |
    /// | --- | --- | --- |
    /// | `Percentage` | `percentOff` (1 to 90) | That share of the subtotal |
    /// | `FixedAmount` | `amountOff` and `currency` | A fixed amount, on orders in that currency |
    /// | `FreeShipping` | nothing | The shipping cost |
    ///
    /// The code must be new (409 otherwise). `id`, `redeemed` and `isActive` are set by the API. Requires the `admin` role.
    /// </remarks>
    /// <param name="request">The coupon to create.</param>
    /// <response code="201">The coupon was created.</response>
    /// <response code="400">A field was missing or invalid.</response>
    /// <response code="409">A coupon with this code already exists.</response>
    internal static async Task<IResult> Create(Coupon request, StoreDbContext db, ClaimsPrincipal principal, DemoNotificationQueue notifications, SendproofPreview preview)
    {
        var errors = EndpointSupport.Validate(request);
        Currency? currency = null;
        if (request is FixedAmountCoupon fixedAmount)
        {
            currency = EndpointSupport.ParseCurrency(fixedAmount.Currency);
            if (currency is null) errors["currency"] = [$"Use one of: {EndpointSupport.CurrencyNames}."];
            else if (EndpointSupport.HasTooManyDecimals(fixedAmount.AmountOff, currency.Value))
                errors["amountOff"] = [$"{currency} amounts allow at most {EndpointSupport.Decimals(currency.Value)} decimal places."];
        }
        if (request.ExpiresOn is { } expires && expires < DateOnly.FromDateTime(DateTime.UtcNow)) errors["expiresOn"] = ["The expiry date cannot be in the past."];
        if (errors.Count > 0) return Results.ValidationProblem(errors);
        if (await db.Coupons.AnyAsync(c => c.Code == request.Code)) return EndpointSupport.Conflict($"A coupon with the code {request.Code} already exists.");

        var coupon = new CouponRecord
        {
            Id = Guid.NewGuid(), Code = request.Code, Description = request.Description, MinSubtotal = request.MinSubtotal,
            MaxRedemptions = request.MaxRedemptions, ExpiresOn = request.ExpiresOn, IsActive = true,
            Kind = request switch { PercentageCoupon => CouponKind.Percentage, FixedAmountCoupon => CouponKind.FixedAmount, _ => CouponKind.FreeShipping },
            PercentOff = (request as PercentageCoupon)?.PercentOff, AmountOff = (request as FixedAmountCoupon)?.AmountOff, Currency = currency
        };
        db.Coupons.Add(coupon);
        db.Audit("Coupon", coupon.Id, "Coupon.Created", principal.Email());
        await db.SaveChangesAsync();
        notifications.CouponCreated(coupon, preview);
        return TypedResults.Created($"/api/v2/coupons/{coupon.Id}", coupon.ToContract());
    }
}
