using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using TestBench.AspNetCore;

namespace TreasuryApi;

/// <summary>The FX operations: quote a rate, book a deal, list, read and cancel deals.</summary>
internal static class FxEndpoints
{
    /// <summary>How far the market may move between quote and booking, as a fraction of the rate (0.1%).</summary>
    private const decimal Tolerance = 0.001m;

    internal static void MapFxEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v2/fx").WithTags("FX deals");
        group.MapPost("/quotes", Quote).WithName("FxController.Quote").RequireAuthorization()
            .Produces<FxQuote>().ProducesValidationProblem();
        group.MapPost("/deals", Book).WithName("FxController.Book").RequireAuthorization(Policies.Writers)
            .Produces<FxDeal>(StatusCodes.Status201Created).ProducesValidationProblem().ProducesProblem(StatusCodes.Status409Conflict)
            .WithTestBenchPreview();
        group.MapGet("/deals", List).WithName("FxController.List").RequireAuthorization()
            .WithMetadata(new SortKeysMetadata(SortKeys.FxDeals)).Produces<PagedList<FxDeal>>().ProducesValidationProblem();
        group.MapGet("/deals/{id:guid}", Get).WithName("FxController.Get").RequireAuthorization()
            .Produces<FxDeal>().ProducesProblem(StatusCodes.Status404NotFound);
        group.MapPost("/deals/{id:guid}/cancel", Cancel).WithName("FxController.Cancel").RequireAuthorization(Policies.Writers)
            .Produces<FxDeal>().ProducesProblem(StatusCodes.Status404NotFound).ProducesProblem(StatusCodes.Status409Conflict)
            .WithTestBenchPreview();
    }

    /// <summary>Quote FX rate</summary>
    /// <remarks>
    /// Returns an indicative all-in rate for buying or selling the **base** currency of a pair (the first three
    /// letters of `EURUSD`). Spot deals settle two business days out; for a forward, pass `valueDate` and the
    /// quote includes **forward points** that follow the interest-rate differential. The quote is valid for
    /// 30 seconds. Book it with `FxController.Book`, passing back the same `rate`.
    /// </remarks>
    /// <param name="request">The deal to price.</param>
    /// <response code="200">The quote.</response>
    /// <response code="400">A field was invalid, such as a forward without a value date.</response>
    internal static IResult Quote(FxQuoteRequest request)
    {
        var errors = Check(request.Type, request.BaseAmount, request.ValueDate, request.Pair);
        if (errors.Count > 0) return Results.ValidationProblem(errors);
        var (rate, points, valueDate) = FxMarket.Price(request.Pair, request.Side, request.Type, request.ValueDate, Today());
        var (baseCurrency, quoteCurrency) = Mapping.Currencies(request.Pair);
        return TypedResults.Ok(new FxQuote
        {
            Pair = request.Pair, Side = request.Side, Type = request.Type, Rate = rate, ForwardPoints = points,
            BaseAmount = Mapping.Money(request.BaseAmount, baseCurrency),
            QuoteAmount = Mapping.Money(FxMarket.QuoteAmount(request.Pair, request.BaseAmount, rate), quoteCurrency),
            ValueDate = valueDate, ValidUntil = DateTimeOffset.UtcNow.AddSeconds(30)
        });
    }

    /// <summary>Book FX deal</summary>
    /// <remarks>
    /// Books a spot or forward deal with the dealing bank at the rate you were quoted. The rate must be within 0.1%
    /// of the current rate, otherwise the answer is 409 and you should quote again. A booked deal is published to the
    /// treasury management system. Requires the `admin` or `payments.approve` role.
    /// </remarks>
    /// <param name="request">The deal to book.</param>
    /// <response code="201">The deal was booked. The `Location` header points to it.</response>
    /// <response code="400">A field was invalid.</response>
    /// <response code="409">The market has moved since the quote; ask for a new quote.</response>
    internal static async Task<IResult> Book(BookFxDealRequest request, TreasuryDbContext db, ClaimsPrincipal principal,
        DemoNotificationQueue notifications, TestBenchPreview preview)
    {
        var errors = Check(request.Type, request.BaseAmount, request.ValueDate, request.Pair);
        errors = EndpointSupport.Validate(request).Concat(errors).GroupBy(e => e.Key).ToDictionary(g => g.Key, g => g.SelectMany(e => e.Value).ToArray());
        if (errors.Count > 0) return Results.ValidationProblem(errors);
        var today = Today();
        var (rate, points, valueDate) = FxMarket.Price(request.Pair, request.Side, request.Type, request.ValueDate, today);
        if (Math.Abs(request.Rate - rate) / rate > Tolerance)
            return EndpointSupport.Conflict($"The market moved: the current rate for {request.Pair} is {rate}. Ask for a new quote.");
        var deal = new FxDealRecord
        {
            Id = Guid.NewGuid(), Number = await NextNumberAsync(db), Type = request.Type, Pair = request.Pair, Side = request.Side,
            BaseAmount = request.BaseAmount, Rate = request.Rate, ForwardPoints = points, QuoteAmount = FxMarket.QuoteAmount(request.Pair, request.BaseAmount, request.Rate),
            TradeDate = today, ValueDate = valueDate, Status = FxDealStatus.Booked, Bank = "J.P. Morgan", BookedBy = principal.Email(),
            BookedAt = DateTimeOffset.UtcNow
        };
        db.FxDeals.Add(deal);
        db.Audit("FxDeal", deal.Id, "FxDeal.Booked", deal.BookedBy);
        await db.SaveChangesAsync();
        notifications.FxDealBooked(deal, preview);
        return TypedResults.Created($"/api/v2/fx/deals/{deal.Id}", deal.ToContract(principal.DisplayName()));
    }

    /// <summary>List FX deals</summary>
    /// <remarks>
    /// Returns deals of both kinds. Each item has a `type` of `Spot` or `Forward`, and forward deals also carry
    /// their value date, forward points and days to maturity. Newest value date first unless you pass `sort`.
    /// </remarks>
    /// <param name="page">The 1-based page number.</param>
    /// <param name="pageSize">How many deals to return per page, from 1 to 100.</param>
    /// <param name="type">Only spot or only forward deals.</param>
    /// <param name="pair">Only deals in this currency pair.</param>
    /// <param name="status">Only deals with this status.</param>
    /// <param name="side">Only deals where Acme buys, or only where it sells, the base currency.</param>
    /// <param name="valueDateFrom">Only deals settling on or after this date.</param>
    /// <param name="valueDateTo">Only deals settling on or before this date.</param>
    /// <param name="q">Search text matched against the deal number and the bank.</param>
    /// <param name="sort">The sort order: a field name, with a leading minus for descending. Defaults to `-valueDate`.</param>
    /// <response code="200">A page of deals.</response>
    /// <response code="400">A paging, sort or filter value was invalid.</response>
    internal static async Task<IResult> List(TreasuryDbContext db, int page = 1, int pageSize = EndpointSupport.DefaultPageSize,
        FxDealType? type = null, FxPair? pair = null, FxDealStatus? status = null, FxSide? side = null,
        DateOnly? valueDateFrom = null, DateOnly? valueDateTo = null, string? q = null, string? sort = null)
    {
        var errors = new Dictionary<string, string[]>();
        EndpointSupport.CheckPaging(page, pageSize, errors);
        EndpointSupport.CheckSort(sort, SortKeys.FxDeals, errors);
        EndpointSupport.CheckRange(valueDateFrom, valueDateTo, nameof(valueDateFrom), nameof(valueDateTo), errors);
        if (errors.Count > 0) return Results.ValidationProblem(errors);

        var query = db.FxDeals.AsNoTracking().AsQueryable();
        if (type is { } t) query = query.Where(d => d.Type == t);
        if (pair is { } p) query = query.Where(d => d.Pair == p);
        if (status is { } s) query = query.Where(d => d.Status == s);
        if (side is { } sd) query = query.Where(d => d.Side == sd);
        if (valueDateFrom is { } from) query = query.Where(d => d.ValueDate >= from);
        if (valueDateTo is { } to) query = query.Where(d => d.ValueDate <= to);
        if (!string.IsNullOrWhiteSpace(q))
        {
            var pattern = EndpointSupport.LikePattern(q);
            query = query.Where(d => EF.Functions.Like(d.Number, pattern, "\\") || EF.Functions.Like(d.Bank, pattern, "\\"));
        }
        var ordered = (sort ?? "-valueDate") switch
        {
            "valueDate" => EndpointSupport.Sorted(query, false, d => d.ValueDate, d => d.Id),
            "baseAmount" => EndpointSupport.Sorted(query, false, d => d.BaseAmount, d => d.Id),
            "-baseAmount" => EndpointSupport.Sorted(query, true, d => d.BaseAmount, d => d.Id),
            "tradeDate" => EndpointSupport.Sorted(query, false, d => d.TradeDate, d => d.Id),
            "-tradeDate" => EndpointSupport.Sorted(query, true, d => d.TradeDate, d => d.Id),
            _ => EndpointSupport.Sorted(query, true, d => d.ValueDate, d => d.Id)
        };
        return TypedResults.Ok(await EndpointSupport.PageAsync(ordered, page, pageSize, async rows => await ToContractsAsync(db, rows)));
    }

    /// <summary>Get FX deal</summary>
    /// <remarks>Returns one deal. Check `type` to know whether it is a `Spot` or a `Forward` deal.</remarks>
    /// <param name="id">The deal's ID, from `FxController.List`.</param>
    /// <response code="200">The deal.</response>
    /// <response code="404">No deal has this ID.</response>
    internal static async Task<IResult> Get(Guid id, TreasuryDbContext db) =>
        await db.FxDeals.AsNoTracking().SingleOrDefaultAsync(d => d.Id == id) is { } deal
            ? TypedResults.Ok((await ToContractsAsync(db, [deal]))[0]) : EndpointSupport.NotFound("FX deal", id);

    /// <summary>Cancel FX deal</summary>
    /// <remarks>
    /// Cancels a **booked** deal whose value date has not passed. Settled and already cancelled deals cannot be
    /// cancelled. Requires the `admin` or `payments.approve` role.
    /// </remarks>
    /// <param name="id">The deal's ID.</param>
    /// <param name="request">An optional reason, kept on the deal.</param>
    /// <response code="200">The cancelled deal.</response>
    /// <response code="404">No deal has this ID.</response>
    /// <response code="409">The deal is settled, already cancelled or past its value date.</response>
    internal static async Task<IResult> Cancel(Guid id, TreasuryDbContext db, ClaimsPrincipal principal,
        DemoNotificationQueue notifications, TestBenchPreview preview, CancelFxDealRequest? request = null)
    {
        var deal = await db.FxDeals.SingleOrDefaultAsync(d => d.Id == id);
        if (deal is null) return EndpointSupport.NotFound("FX deal", id);
        if (deal.Status != FxDealStatus.Booked) return EndpointSupport.Conflict($"A {deal.Status} deal cannot be cancelled.");
        if (deal.ValueDate < Today()) return EndpointSupport.Conflict("The value date has passed.");
        deal.Status = FxDealStatus.Cancelled;
        deal.CancelReason = string.IsNullOrWhiteSpace(request?.Reason) ? null : request.Reason;
        db.Audit("FxDeal", deal.Id, "FxDeal.Cancelled", principal.Email());
        await db.SaveChangesAsync();
        notifications.FxDealCancelled(deal, preview);
        return TypedResults.Ok((await ToContractsAsync(db, [deal]))[0]);
    }

    private static DateOnly Today() => DateOnly.FromDateTime(DateTime.UtcNow);

    private static Dictionary<string, string[]> Check(FxDealType type, decimal baseAmount, DateOnly? valueDate, FxPair pair)
    {
        var errors = new Dictionary<string, string[]>();
        var (baseCurrency, _) = Mapping.Currencies(pair);
        if (baseAmount < 1m) errors["baseAmount"] = ["The amount must be at least 1."];
        else if (EndpointSupport.HasTooManyDecimals(baseAmount, baseCurrency))
            errors["baseAmount"] = [$"{baseCurrency} amounts allow at most {EndpointSupport.Decimals(baseCurrency)} decimal places."];
        if (type == FxDealType.Forward)
        {
            var today = Today();
            if (valueDate is null) errors["valueDate"] = ["A forward deal needs a value date."];
            else if (valueDate < today.AddDays(3) || valueDate > today.AddDays(365)) errors["valueDate"] = ["The value date must be 3 to 365 days from today."];
            else if (valueDate.Value.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday) errors["valueDate"] = ["The value date must be a business day."];
        }
        return errors;
    }

    private static async Task<IReadOnlyList<FxDeal>> ToContractsAsync(TreasuryDbContext db, IReadOnlyList<FxDealRecord> deals)
    {
        var emails = deals.Select(d => d.BookedBy).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => emails.Contains(u.Email)).ToDictionaryAsync(u => u.Email, u => u.Name);
        return deals.Select(d => d.ToContract(names.GetValueOrDefault(d.BookedBy, d.BookedBy))).ToList();
    }

    private static async Task<string> NextNumberAsync(TreasuryDbContext db)
    {
        var prefix = $"FX-{DateTime.UtcNow.Year}-";
        var last = await db.FxDeals.AsNoTracking().Where(d => d.Number.StartsWith(prefix)).OrderByDescending(d => d.Number)
            .Select(d => d.Number).FirstOrDefaultAsync();
        return $"{prefix}{(last is null ? 1 : int.Parse(last[prefix.Length..]) + 1):0000}";
    }
}
