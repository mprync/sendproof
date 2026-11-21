using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using Sendproof.AspNetCore;

namespace TreasuryApi;

/// <summary>Role requirements shared by the endpoint groups.</summary>
internal static class Policies
{
    /// <summary>Users who may create and change business data.</summary>
    internal static readonly Action<Microsoft.AspNetCore.Authorization.AuthorizationPolicyBuilder> Writers =
        policy => policy.RequireRole("admin", "payments.approve");

    /// <summary>Users who may administer accounts and user roles.</summary>
    internal static readonly Action<Microsoft.AspNetCore.Authorization.AuthorizationPolicyBuilder> Admins =
        policy => policy.RequireRole("admin");
}

/// <summary>The bank account operations: list, read, register, change and close.</summary>
internal static class AccountEndpoints
{
    internal static void MapAccountEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v2/accounts").WithTags("Accounts");
        group.MapGet("/", List).WithName("AccountsController.List").RequireAuthorization()
            .WithMetadata(new SortKeysMetadata(SortKeys.Accounts, SortKeys.AccountDescriptions)).Produces<PagedList<Account>>().ProducesValidationProblem();
        group.MapGet("/{id:guid}", Get).WithName("AccountsController.Get").RequireAuthorization()
            .Produces<Account>().ProducesProblem(StatusCodes.Status404NotFound);
        group.MapPost("/", Create).WithName("AccountsController.Create").RequireAuthorization(Policies.Admins)
            .Produces<Account>(StatusCodes.Status201Created).ProducesValidationProblem().ProducesProblem(StatusCodes.Status409Conflict)
            .WithSendproofPreview();
        group.MapPut("/{id:guid}", Update).WithName("AccountsController.Update").RequireAuthorization(Policies.Admins)
            .Produces<Account>().ProducesValidationProblem().ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict).WithSendproofPreview();
        group.MapPost("/{id:guid}/close", Close).WithName("AccountsController.Close").RequireAuthorization(Policies.Admins)
            .Produces<Account>().ProducesProblem(StatusCodes.Status404NotFound).ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity).WithSendproofPreview();
    }

    /// <summary>List accounts</summary>
    /// <remarks>
    /// Returns the bank accounts of every Acme entity, sorted by name unless you pass `sort`.
    /// Use `status=Open` to list the accounts that can be debited. Balances are on each account; for the
    /// cash position across accounts see `BalancesController.List`.
    /// </remarks>
    /// <param name="page">The 1-based page number.</param>
    /// <param name="pageSize">How many accounts to return per page, from 1 to 100.</param>
    /// <param name="status">Only accounts with this status.</param>
    /// <param name="type">Only accounts of this type.</param>
    /// <param name="currency">Only accounts in this currency.</param>
    /// <param name="q">Search text matched against name, entity, bank and IBAN.</param>
    /// <param name="sort">The sort order: a field name, with a leading minus for descending. Defaults to `name`.</param>
    /// <response code="200">A page of accounts.</response>
    /// <response code="400">A paging or sort value was invalid.</response>
    internal static async Task<IResult> List(TreasuryDbContext db, int page = 1, int pageSize = EndpointSupport.DefaultPageSize,
        AccountStatus? status = null, AccountType? type = null, Currency? currency = null, string? q = null, string? sort = null)
    {
        var errors = new Dictionary<string, string[]>();
        EndpointSupport.CheckPaging(page, pageSize, errors);
        EndpointSupport.CheckSort(sort, SortKeys.Accounts, errors);
        if (errors.Count > 0) return Results.ValidationProblem(errors);

        var query = db.Accounts.AsNoTracking().AsQueryable();
        if (status is { } s) query = query.Where(a => a.Status == s);
        if (type is { } t) query = query.Where(a => a.Type == t);
        if (currency is { } c) query = query.Where(a => a.Currency == c);
        if (!string.IsNullOrWhiteSpace(q))
        {
            var pattern = EndpointSupport.LikePattern(q);
            query = query.Where(a => EF.Functions.Like(a.Name, pattern, "\\") || EF.Functions.Like(a.Entity, pattern, "\\") ||
                EF.Functions.Like(a.BankName, pattern, "\\") || EF.Functions.Like(a.Iban, pattern, "\\"));
        }
        var ordered = (sort ?? "name") switch
        {
            "-name" => EndpointSupport.Sorted(query, true, a => a.Name, a => a.Id),
            "balance" => EndpointSupport.Sorted(query, false, a => a.AvailableBalance, a => a.Id),
            "-balance" => EndpointSupport.Sorted(query, true, a => a.AvailableBalance, a => a.Id),
            "openedOn" => EndpointSupport.Sorted(query, false, a => a.OpenedOn, a => a.Id),
            "-openedOn" => EndpointSupport.Sorted(query, true, a => a.OpenedOn, a => a.Id),
            _ => EndpointSupport.Sorted(query, false, a => a.Name, a => a.Id)
        };
        return TypedResults.Ok(await EndpointSupport.PageAsync(ordered, page, pageSize,
            rows => Task.FromResult<IReadOnlyList<Account>>(rows.Select(a => a.ToContract()).ToList())));
    }

    /// <summary>Get account</summary>
    /// <remarks>Returns one account with its balances. For the intraday history see `BalancesController.History`.</remarks>
    /// <param name="id">The account's ID, from `AccountsController.List`.</param>
    /// <response code="200">The account.</response>
    /// <response code="404">No account has this ID.</response>
    internal static async Task<IResult> Get(Guid id, TreasuryDbContext db) =>
        await db.Accounts.AsNoTracking().SingleOrDefaultAsync(a => a.Id == id) is { } account
            ? TypedResults.Ok(account.ToContract()) : EndpointSupport.NotFound("account", id);

    /// <summary>Register account</summary>
    /// <remarks>
    /// Registers a bank account that Acme holds. The IBAN's check digits are verified, and both the name and the
    /// IBAN must be new. The account starts **open** with a zero balance. Requires the `admin` role.
    /// </remarks>
    /// <param name="request">The account to register.</param>
    /// <response code="201">The account was registered. The `Location` header points to it.</response>
    /// <response code="400">A field was missing or invalid, including an IBAN with wrong check digits.</response>
    /// <response code="409">An account with this name or IBAN already exists.</response>
    internal static async Task<IResult> Create(CreateAccountRequest request, TreasuryDbContext db, ClaimsPrincipal principal)
    {
        var errors = EndpointSupport.Validate(request);
        var iban = IbanTools.Format(request.Iban);
        if (!errors.ContainsKey("iban") && !IbanTools.IsValid(iban)) errors["iban"] = ["The IBAN's check digits are wrong."];
        if (errors.Count > 0) return Results.ValidationProblem(errors);
        if (await db.Accounts.AnyAsync(a => a.Name == request.Name)) return EndpointSupport.Conflict($"An account named {request.Name} already exists.");
        if (await db.Accounts.AnyAsync(a => a.Iban == iban)) return EndpointSupport.Conflict($"An account with IBAN {iban} already exists.");
        var account = new AccountRecord
        {
            Id = Guid.NewGuid(), Name = request.Name, Entity = request.Entity, EntityCountry = request.EntityCountry,
            BankName = request.BankName, Bic = request.Bic, Iban = iban, Currency = request.Currency, Type = request.Type,
            Status = AccountStatus.Open, OpenedOn = DateOnly.FromDateTime(DateTime.UtcNow), Description = request.Description
        };
        db.Accounts.Add(account);
        db.Audit("Account", account.Id, "Account.Created", principal.Email());
        await db.SaveChangesAsync();
        return TypedResults.Created($"/api/v2/accounts/{account.Id}", account.ToContract());
    }

    /// <summary>Update account</summary>
    /// <remarks>
    /// Changes an account's name and note, and freezes or unfreezes it. A **frozen** account cannot be debited.
    /// Closed accounts cannot be changed. Requires the `admin` role.
    /// </remarks>
    /// <param name="id">The account's ID.</param>
    /// <param name="request">The new values. Every field is replaced.</param>
    /// <response code="200">The updated account.</response>
    /// <response code="400">A field was invalid, or the status asked for a closure.</response>
    /// <response code="404">No account has this ID.</response>
    /// <response code="409">The account is closed, or another account already has this name.</response>
    internal static async Task<IResult> Update(Guid id, UpdateAccountRequest request, TreasuryDbContext db, ClaimsPrincipal principal)
    {
        var account = await db.Accounts.SingleOrDefaultAsync(a => a.Id == id);
        if (account is null) return EndpointSupport.NotFound("account", id);
        if (account.Status == AccountStatus.Closed) return EndpointSupport.Conflict("A closed account cannot be changed.");
        var errors = EndpointSupport.Validate(request);
        if (request.Status == AccountStatus.Closed) errors["status"] = ["Use the close operation to close an account."];
        if (errors.Count > 0) return Results.ValidationProblem(errors);
        if (await db.Accounts.AnyAsync(a => a.Name == request.Name && a.Id != id)) return EndpointSupport.Conflict($"An account named {request.Name} already exists.");
        account.Name = request.Name;
        account.Description = request.Description;
        account.Status = request.Status;
        db.Audit("Account", account.Id, "Account.Updated", principal.Email());
        await db.SaveChangesAsync();
        return TypedResults.Ok(account.ToContract());
    }

    /// <summary>Close account</summary>
    /// <remarks>
    /// Closes an account for good. Its ledger and available balances must both be zero and no payment may still
    /// be waiting on it. Requires the `admin` role.
    /// </remarks>
    /// <param name="id">The account's ID.</param>
    /// <response code="200">The closed account.</response>
    /// <response code="404">No account has this ID.</response>
    /// <response code="409">The account is already closed.</response>
    /// <response code="422">The account still holds money or has payments waiting.</response>
    internal static async Task<IResult> Close(Guid id, TreasuryDbContext db, ClaimsPrincipal principal,
        DemoNotificationQueue notifications, SendproofPreview preview)
    {
        var account = await db.Accounts.SingleOrDefaultAsync(a => a.Id == id);
        if (account is null) return EndpointSupport.NotFound("account", id);
        if (account.Status == AccountStatus.Closed) return EndpointSupport.Conflict("The account is already closed.");
        if (account.LedgerBalance != 0m || account.AvailableBalance != 0m)
            return EndpointSupport.Unprocessable("Move the remaining balance out before closing the account.");
        var open = PaymentEndpoints.FundsReserved;
        if (await db.Payments.AnyAsync(p => p.DebitAccountId == id && open.Contains(p.Status)))
            return EndpointSupport.Unprocessable("Cancel or complete the payments waiting on this account first.");
        account.Status = AccountStatus.Closed;
        account.ClosedOn = DateOnly.FromDateTime(DateTime.UtcNow);
        db.Audit("Account", account.Id, "Account.Closed", principal.Email());
        await db.SaveChangesAsync();
        notifications.AccountClosed(account, preview);
        return TypedResults.Ok(account.ToContract());
    }
}
