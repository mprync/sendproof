using Microsoft.EntityFrameworkCore;

namespace TreasuryApi;

/// <summary>The bank statement operations: list statements, read one and page through its entries.</summary>
internal static class StatementEndpoints
{
    internal static void MapStatementEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v2/bank-statements").WithTags("Bank statements");
        group.MapGet("/", List).WithName("StatementsController.List").RequireAuthorization()
            .WithMetadata(new SortKeysMetadata(SortKeys.Statements)).Produces<PagedList<BankStatementSummary>>().ProducesValidationProblem();
        group.MapGet("/{id:guid}", Get).WithName("StatementsController.Get").RequireAuthorization()
            .Produces<BankStatement>().ProducesProblem(StatusCodes.Status404NotFound);
        group.MapGet("/{id:guid}/entries", Entries).WithName("StatementsController.Entries").RequireAuthorization()
            .Produces<PagedList<StatementEntry>>().ProducesValidationProblem().ProducesProblem(StatusCodes.Status404NotFound);
    }

    /// <summary>List bank statements</summary>
    /// <remarks>
    /// Returns the daily statements the banks delivered, newest first unless you pass `sort`. Each row has the
    /// opening and closing balance and the number of entries; open one with `StatementsController.Get`.
    /// </remarks>
    /// <param name="page">The 1-based page number.</param>
    /// <param name="pageSize">How many statements to return per page, from 1 to 100.</param>
    /// <param name="accountId">Only statements for this account.</param>
    /// <param name="currency">Only statements in this currency.</param>
    /// <param name="from">Only statements for this business day or later.</param>
    /// <param name="to">Only statements for this business day or earlier.</param>
    /// <param name="sort">The sort order: `statementDate` or `-statementDate`. Defaults to `-statementDate`.</param>
    /// <response code="200">A page of statements.</response>
    /// <response code="400">A paging, sort or filter value was invalid.</response>
    internal static async Task<IResult> List(TreasuryDbContext db, int page = 1, int pageSize = EndpointSupport.DefaultPageSize,
        Guid? accountId = null, Currency? currency = null, DateOnly? from = null, DateOnly? to = null, string? sort = null)
    {
        var errors = new Dictionary<string, string[]>();
        EndpointSupport.CheckPaging(page, pageSize, errors);
        EndpointSupport.CheckSort(sort, SortKeys.Statements, errors);
        EndpointSupport.CheckRange(from, to, nameof(from), nameof(to), errors);
        if (errors.Count > 0) return Results.ValidationProblem(errors);

        var query = db.BankStatements.AsNoTracking().AsQueryable();
        if (accountId is { } a) query = query.Where(s => s.AccountId == a);
        if (currency is { } c) query = query.Where(s => s.Currency == c);
        if (from is { } f) query = query.Where(s => s.StatementDate >= f);
        if (to is { } t) query = query.Where(s => s.StatementDate <= t);
        var ordered = sort == "statementDate"
            ? EndpointSupport.Sorted(query, false, s => s.StatementDate, s => s.Number)
            : EndpointSupport.Sorted(query, true, s => s.StatementDate, s => s.Number);
        return TypedResults.Ok(await EndpointSupport.PageAsync(ordered, page, pageSize, async rows =>
        {
            var ids = rows.Select(s => s.Id).ToList();
            var accountIds = rows.Select(s => s.AccountId).Distinct().ToList();
            var accounts = await db.Accounts.AsNoTracking().Where(x => accountIds.Contains(x.Id)).ToDictionaryAsync(x => x.Id);
            var counts = await db.StatementEntries.AsNoTracking().Where(e => ids.Contains(e.StatementId))
                .GroupBy(e => e.StatementId).Select(g => new { g.Key, Count = g.Count() }).ToDictionaryAsync(g => g.Key, g => g.Count);
            return (IReadOnlyList<BankStatementSummary>)rows.Select(s => ToSummary(s, accounts[s.AccountId], counts.GetValueOrDefault(s.Id))).ToList();
        }));
    }

    /// <summary>Get bank statement</summary>
    /// <remarks>
    /// Returns a statement with every entry. The closing balance equals the opening balance plus credits and
    /// interest, less debits and fees. For statements with many entries, page through them with `StatementsController.Entries`.
    /// </remarks>
    /// <param name="id">The statement's ID, from `StatementsController.List`.</param>
    /// <response code="200">The statement with its entries.</response>
    /// <response code="404">No statement has this ID.</response>
    internal static async Task<IResult> Get(Guid id, TreasuryDbContext db)
    {
        var statement = await db.BankStatements.AsNoTracking().Include(s => s.Entries).SingleOrDefaultAsync(s => s.Id == id);
        if (statement is null) return EndpointSupport.NotFound("bank statement", id);
        var account = await db.Accounts.AsNoTracking().SingleAsync(a => a.Id == statement.AccountId);
        var summary = ToSummary(statement, account, statement.Entries.Count);
        return TypedResults.Ok(new BankStatement
        {
            Id = summary.Id, Number = summary.Number, Account = summary.Account, StatementDate = summary.StatementDate,
            OpeningBalance = summary.OpeningBalance, ClosingBalance = summary.ClosingBalance, EntryCount = summary.EntryCount,
            ReceivedAt = summary.ReceivedAt,
            Entries = statement.Entries.OrderBy(e => e.Sequence).Select(e => e.ToContract(statement.Currency)).ToList()
        });
    }

    /// <summary>List statement entries</summary>
    /// <remarks>Returns the entries of one statement in the order the bank reported them, with optional filters.</remarks>
    /// <param name="id">The statement's ID.</param>
    /// <param name="page">The 1-based page number.</param>
    /// <param name="pageSize">How many entries to return per page, from 1 to 100.</param>
    /// <param name="type">Only entries of this type.</param>
    /// <param name="q">Search text matched against the counterparty name, remittance text and end-to-end ID.</param>
    /// <response code="200">A page of entries.</response>
    /// <response code="400">A paging value was invalid.</response>
    /// <response code="404">No statement has this ID.</response>
    internal static async Task<IResult> Entries(Guid id, TreasuryDbContext db, int page = 1,
        int pageSize = EndpointSupport.DefaultPageSize, StatementEntryType? type = null, string? q = null)
    {
        var errors = new Dictionary<string, string[]>();
        EndpointSupport.CheckPaging(page, pageSize, errors);
        if (errors.Count > 0) return Results.ValidationProblem(errors);
        var statement = await db.BankStatements.AsNoTracking().SingleOrDefaultAsync(s => s.Id == id);
        if (statement is null) return EndpointSupport.NotFound("bank statement", id);
        var query = db.StatementEntries.AsNoTracking().Where(e => e.StatementId == id);
        if (type is { } t) query = query.Where(e => e.Type == t);
        if (!string.IsNullOrWhiteSpace(q))
        {
            var pattern = EndpointSupport.LikePattern(q);
            query = query.Where(e => EF.Functions.Like(e.CounterpartyName!, pattern, "\\") || EF.Functions.Like(e.Remittance!, pattern, "\\") ||
                EF.Functions.Like(e.EndToEndId!, pattern, "\\"));
        }
        var ordered = EndpointSupport.Sorted(query, false, e => e.Sequence, e => e.Id);
        return TypedResults.Ok(await EndpointSupport.PageAsync(ordered, page, pageSize, rows =>
            Task.FromResult<IReadOnlyList<StatementEntry>>(rows.Select(e => e.ToContract(statement.Currency)).ToList())));
    }

    private static BankStatementSummary ToSummary(BankStatementRecord s, AccountRecord account, int entryCount) => new()
    {
        Id = s.Id, Number = s.Number, Account = account.ToReference(), StatementDate = s.StatementDate,
        OpeningBalance = Mapping.Money(s.OpeningBalance, s.Currency), ClosingBalance = Mapping.Money(s.ClosingBalance, s.Currency),
        EntryCount = entryCount, ReceivedAt = s.ReceivedAt
    };
}
