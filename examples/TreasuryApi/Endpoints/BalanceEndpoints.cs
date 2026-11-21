using Microsoft.EntityFrameworkCore;

namespace TreasuryApi;

/// <summary>The balance operations: cash position, a single account's balance and its intraday history.</summary>
internal static class BalanceEndpoints
{
    /// <summary>How the legacy balance operation is retired; read by the OpenAPI document and the response headers.</summary>
    private static readonly DeprecationMetadata LegacyBalanceRetirement = new(
        [
            new("BalancesController.Get", "The same account, with the ledger and reserved amounts too.", new Dictionary<string, string> { ["accountId"] = "$request.path.id" }),
            new("BalancesController.List", "Every account’s balance in one call.")
        ],
        new DateOnly(2027, 6, 30));

    internal static void MapBalanceEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v2/balances").WithTags("Balances");
        group.MapGet("/", List).WithName("BalancesController.List").RequireAuthorization()
            .Produces<PagedList<AccountBalance>>().ProducesValidationProblem();
        group.MapGet("/{accountId:guid}", Get).WithName("BalancesController.Get").RequireAuthorization()
            .Produces<AccountBalance>().ProducesProblem(StatusCodes.Status404NotFound);
        group.MapGet("/{accountId:guid}/history", History).WithName("BalancesController.History").RequireAuthorization()
            .Produces<PagedList<BalancePoint>>().ProducesValidationProblem().ProducesProblem(StatusCodes.Status404NotFound);
        app.MapGet("/api/v2/accounts/{id:guid}/balance", LegacyBalance).WithTags("Balances").WithName("BalancesController.LegacyBalance")
            .RequireAuthorization().WithMetadata(new ObsoleteAttribute("Use GET /api/v2/balances/{accountId}."), LegacyBalanceRetirement)
            .Produces<LegacyAccountBalance>().ProducesProblem(StatusCodes.Status404NotFound);
    }

    /// <summary>List balances</summary>
    /// <remarks>
    /// Returns the current cash position: one row per open or frozen account with its ledger, available and
    /// reserved amounts. Closed accounts are left out. Use `currency` to total one currency yourself.
    /// </remarks>
    /// <param name="page">The 1-based page number.</param>
    /// <param name="pageSize">How many balances to return per page, from 1 to 100.</param>
    /// <param name="currency">Only accounts in this currency.</param>
    /// <param name="q">Search text matched against account name, entity and IBAN.</param>
    /// <response code="200">A page of balances, ordered by account name.</response>
    /// <response code="400">A paging value was invalid.</response>
    internal static async Task<IResult> List(TreasuryDbContext db, int page = 1, int pageSize = EndpointSupport.DefaultPageSize,
        Currency? currency = null, string? q = null)
    {
        var errors = new Dictionary<string, string[]>();
        EndpointSupport.CheckPaging(page, pageSize, errors);
        if (errors.Count > 0) return Results.ValidationProblem(errors);
        var query = db.Accounts.AsNoTracking().Where(a => a.Status != AccountStatus.Closed);
        if (currency is { } c) query = query.Where(a => a.Currency == c);
        if (!string.IsNullOrWhiteSpace(q))
        {
            var pattern = EndpointSupport.LikePattern(q);
            query = query.Where(a => EF.Functions.Like(a.Name, pattern, "\\") || EF.Functions.Like(a.Entity, pattern, "\\") ||
                EF.Functions.Like(a.Iban, pattern, "\\"));
        }
        var ordered = EndpointSupport.Sorted(query, false, a => a.Name, a => a.Id);
        return TypedResults.Ok(await EndpointSupport.PageAsync(ordered, page, pageSize, async rows =>
        {
            var ids = rows.Select(a => a.Id).ToList();
            var latest = (await db.BalanceSnapshots.AsNoTracking().Where(s => ids.Contains(s.AccountId)).ToListAsync())
                .GroupBy(s => s.AccountId).ToDictionary(g => g.Key, g => g.Max(s => s.AsOf));
            return (IReadOnlyList<AccountBalance>)rows.Select(a => ToBalance(a, latest.GetValueOrDefault(a.Id))).ToList();
        }));
    }

    /// <summary>Get balance</summary>
    /// <remarks>Returns the current ledger, available and reserved amounts of one account.</remarks>
    /// <param name="accountId">The account's ID, from `AccountsController.List`.</param>
    /// <response code="200">The account's balance.</response>
    /// <response code="404">No account has this ID.</response>
    internal static async Task<IResult> Get(Guid accountId, TreasuryDbContext db)
    {
        var account = await db.Accounts.AsNoTracking().SingleOrDefaultAsync(a => a.Id == accountId);
        if (account is null) return EndpointSupport.NotFound("account", accountId);
        var asOf = (await db.BalanceSnapshots.AsNoTracking().Where(s => s.AccountId == accountId).ToListAsync())
            .Select(s => (DateTimeOffset?)s.AsOf).Max();
        return TypedResults.Ok(ToBalance(account, asOf));
    }

    /// <summary>Get intraday balance history</summary>
    /// <remarks>
    /// Returns the balance of one account at the points in time the bank reported it, newest first. Without
    /// `from` and `to` it covers everything held, which is the last day or so.
    /// </remarks>
    /// <param name="accountId">The account's ID.</param>
    /// <param name="from">Only points at or after this moment, as an ISO 8601 date and time.</param>
    /// <param name="to">Only points at or before this moment, as an ISO 8601 date and time.</param>
    /// <param name="page">The 1-based page number.</param>
    /// <param name="pageSize">How many points to return per page, from 1 to 100.</param>
    /// <response code="200">A page of balance points.</response>
    /// <response code="400">A paging or time value was invalid.</response>
    /// <response code="404">No account has this ID.</response>
    internal static async Task<IResult> History(Guid accountId, TreasuryDbContext db, DateTimeOffset? from = null,
        DateTimeOffset? to = null, int page = 1, int pageSize = EndpointSupport.DefaultPageSize)
    {
        var errors = new Dictionary<string, string[]>();
        EndpointSupport.CheckPaging(page, pageSize, errors);
        if (from is not null && to is not null && to < from) errors["to"] = ["to must not be before from."];
        if (errors.Count > 0) return Results.ValidationProblem(errors);
        if (!await db.Accounts.AnyAsync(a => a.Id == accountId)) return EndpointSupport.NotFound("account", accountId);
        var query = db.BalanceSnapshots.AsNoTracking().Where(s => s.AccountId == accountId);
        if (from is { } f) query = query.Where(s => s.AsOf >= f);
        if (to is { } t) query = query.Where(s => s.AsOf <= t);
        var ordered = EndpointSupport.Sorted(query, true, s => s.AsOf, s => s.Id);
        return TypedResults.Ok(await EndpointSupport.PageAsync(ordered, page, pageSize, rows =>
            Task.FromResult<IReadOnlyList<BalancePoint>>(rows.Select(s => new BalancePoint
            {
                AsOf = s.AsOf, LedgerBalance = s.Ledger, AvailableBalance = s.Available
            }).ToList())));
    }

    /// <summary>Get account balance</summary>
    /// <remarks>
    /// **Deprecated.** Returns only the available balance. Use `BalancesController.Get`, which also reports the
    /// ledger and reserved amounts, or `BalancesController.List` for every account at once.
    /// The response carries a `Deprecation` header, a `Sunset` header with the removal date and a `Link` to its replacement.
    /// </remarks>
    /// <param name="id">The account's ID.</param>
    /// <param name="context">The current HTTP context, used to add the deprecation headers.</param>
    /// <response code="200">The account's available balance.</response>
    /// <response code="404">No account has this ID.</response>
    internal static async Task<IResult> LegacyBalance(Guid id, TreasuryDbContext db, HttpContext context)
    {
        var account = await db.Accounts.AsNoTracking().SingleOrDefaultAsync(a => a.Id == id);
        if (account is null) return EndpointSupport.NotFound("account", id);
        context.Response.Headers["Deprecation"] = "true";
        context.Response.Headers["Sunset"] = LegacyBalanceRetirement.SunsetHttpDate;
        context.Response.Headers.Link = $"</api/v2/balances/{id}>; rel=\"successor-version\"";
        return TypedResults.Ok(new LegacyAccountBalance { AccountId = id, Balance = account.AvailableBalance, Currency = account.Currency });
    }

    private static AccountBalance ToBalance(AccountRecord account, DateTimeOffset? asOf) => new()
    {
        Account = account.ToReference(), LedgerBalance = account.LedgerBalance, AvailableBalance = account.AvailableBalance,
        ReservedAmount = account.LedgerBalance - account.AvailableBalance, AsOf = asOf ?? DateTimeOffset.UtcNow
    };
}
