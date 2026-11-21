using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using Sendproof.AspNetCore;

namespace TreasuryApi;

/// <summary>The counterparty operations: list, read, add, change and archive.</summary>
internal static class CounterpartyEndpoints
{
    internal static void MapCounterpartyEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v2/counterparties").WithTags("Counterparties");
        group.MapGet("/", List).WithName("CounterpartiesController.List").RequireAuthorization()
            .WithMetadata(new SortKeysMetadata(SortKeys.Counterparties)).Produces<PagedList<Counterparty>>().ProducesValidationProblem();
        group.MapGet("/{id:guid}", Get).WithName("CounterpartiesController.Get").RequireAuthorization()
            .Produces<Counterparty>().ProducesProblem(StatusCodes.Status404NotFound);
        group.MapPost("/", Create).WithName("CounterpartiesController.Create").RequireAuthorization(Policies.Writers)
            .Produces<Counterparty>(StatusCodes.Status201Created).ProducesValidationProblem().ProducesProblem(StatusCodes.Status409Conflict)
            .WithSendproofPreview();
        group.MapPut("/{id:guid}", Update).WithName("CounterpartiesController.Update").RequireAuthorization(Policies.Writers)
            .Produces<Counterparty>().ProducesValidationProblem().ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict).WithSendproofPreview();
        group.MapDelete("/{id:guid}", Archive).WithName("CounterpartiesController.Archive").RequireAuthorization(Policies.Writers)
            .Produces(StatusCodes.Status204NoContent).ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict).WithSendproofPreview();
    }

    /// <summary>List counterparties</summary>
    /// <remarks>
    /// Returns the suppliers, customers, group companies and tax authorities Acme pays, sorted by name unless you
    /// pass `sort`. Add `status=Active` to list only those that can be paid.
    /// </remarks>
    /// <param name="page">The 1-based page number.</param>
    /// <param name="pageSize">How many counterparties to return per page, from 1 to 100.</param>
    /// <param name="type">Only counterparties of this type.</param>
    /// <param name="status">Only counterparties with this status.</param>
    /// <param name="country">Only counterparties in this country, as an ISO 3166-1 alpha-2 code such as `DE`.</param>
    /// <param name="q">Search text matched against name, city and account identifier.</param>
    /// <param name="sort">The sort order: a field name, with a leading minus for descending. Defaults to `name`.</param>
    /// <response code="200">A page of counterparties.</response>
    /// <response code="400">A paging, sort or filter value was invalid.</response>
    internal static async Task<IResult> List(TreasuryDbContext db, int page = 1, int pageSize = EndpointSupport.DefaultPageSize,
        CounterpartyType? type = null, CounterpartyStatus? status = null, string? country = null, string? q = null, string? sort = null)
    {
        var errors = new Dictionary<string, string[]>();
        EndpointSupport.CheckPaging(page, pageSize, errors);
        EndpointSupport.CheckSort(sort, SortKeys.Counterparties, errors);
        if (country is not null && (country.Length != 2 || !country.All(char.IsAsciiLetterUpper)))
            errors["country"] = ["Use a two-letter upper-case country code, such as DE."];
        if (errors.Count > 0) return Results.ValidationProblem(errors);

        var query = db.Counterparties.AsNoTracking().AsQueryable();
        if (type is { } t) query = query.Where(c => c.Type == t);
        if (status is { } s) query = query.Where(c => c.Status == s);
        if (country is not null) query = query.Where(c => c.Country == country);
        if (!string.IsNullOrWhiteSpace(q))
        {
            var pattern = EndpointSupport.LikePattern(q);
            query = query.Where(c => EF.Functions.Like(c.Name, pattern, "\\") || EF.Functions.Like(c.City, pattern, "\\") ||
                EF.Functions.Like(c.Iban!, pattern, "\\") || EF.Functions.Like(c.AccountNumber!, pattern, "\\"));
        }
        var ordered = (sort ?? "name") switch
        {
            "-name" => EndpointSupport.Sorted(query, true, c => c.Name, c => c.Id),
            "createdAt" => EndpointSupport.Sorted(query, false, c => c.CreatedAt, c => c.Id),
            "-createdAt" => EndpointSupport.Sorted(query, true, c => c.CreatedAt, c => c.Id),
            _ => EndpointSupport.Sorted(query, false, c => c.Name, c => c.Id)
        };
        return TypedResults.Ok(await EndpointSupport.PageAsync(ordered, page, pageSize,
            rows => Task.FromResult<IReadOnlyList<Counterparty>>(rows.Select(c => c.ToContract()).ToList())));
    }

    /// <summary>Get counterparty</summary>
    /// <remarks>Returns one counterparty with its address and bank details.</remarks>
    /// <param name="id">The counterparty's ID, from `CounterpartiesController.List`.</param>
    /// <response code="200">The counterparty.</response>
    /// <response code="404">No counterparty has this ID.</response>
    internal static async Task<IResult> Get(Guid id, TreasuryDbContext db) =>
        await db.Counterparties.AsNoTracking().SingleOrDefaultAsync(c => c.Id == id) is { } counterparty
            ? TypedResults.Ok(counterparty.ToContract()) : EndpointSupport.NotFound("counterparty", id);

    /// <summary>Add counterparty</summary>
    /// <remarks>
    /// Adds a payee. Choose how its bank account is identified with `bankDetails.scheme`:
    ///
    /// - `Iban` for SEPA and most countries (the IBAN's check digits are verified)
    /// - `UsAch` for US domestic accounts (ABA routing number and account number)
    /// - `Swift` for other international accounts (BIC and local account number)
    ///
    /// The new counterparty is queued for sanctions screening. Requires the `admin` or `payments.approve` role.
    /// </remarks>
    /// <param name="request">The counterparty to add.</param>
    /// <response code="201">The counterparty was added. The `Location` header points to it.</response>
    /// <response code="400">A field was missing or invalid.</response>
    /// <response code="409">An active counterparty with this name already exists.</response>
    internal static async Task<IResult> Create(CreateCounterpartyRequest request, TreasuryDbContext db, ClaimsPrincipal principal,
        DemoNotificationQueue notifications, SendproofPreview preview)
    {
        var errors = EndpointSupport.Validate(request);
        CheckBankDetails(request.BankDetails, errors);
        if (errors.Count > 0) return Results.ValidationProblem(errors);
        if (await db.Counterparties.AnyAsync(c => c.Name == request.Name && c.Status == CounterpartyStatus.Active))
            return EndpointSupport.Conflict($"An active counterparty named {request.Name} already exists.");
        var counterparty = new CounterpartyRecord
        {
            Id = Guid.NewGuid(), Name = request.Name, Type = request.Type, Status = CounterpartyStatus.Active, Country = request.Country,
            AddressLine = request.Address.Line, City = request.Address.City, PostalCode = request.Address.PostalCode,
            ContactEmail = request.ContactEmail, CreatedAt = DateTimeOffset.UtcNow
        };
        counterparty.SetBankDetails(request.BankDetails);
        db.Counterparties.Add(counterparty);
        db.Audit("Counterparty", counterparty.Id, "Counterparty.Created", principal.Email());
        await db.SaveChangesAsync();
        notifications.CounterpartyCreated(counterparty, preview);
        return TypedResults.Created($"/api/v2/counterparties/{counterparty.Id}", counterparty.ToContract());
    }

    /// <summary>Update counterparty</summary>
    /// <remarks>
    /// Replaces a counterparty's name, address, contact email and bank details. The type and country cannot
    /// change. Archived counterparties cannot be updated.
    /// </remarks>
    /// <param name="id">The counterparty's ID.</param>
    /// <param name="request">The new values. Every field is replaced.</param>
    /// <response code="200">The updated counterparty.</response>
    /// <response code="400">A field was invalid.</response>
    /// <response code="404">No counterparty has this ID.</response>
    /// <response code="409">The counterparty is archived, or another active counterparty has this name.</response>
    internal static async Task<IResult> Update(Guid id, UpdateCounterpartyRequest request, TreasuryDbContext db, ClaimsPrincipal principal)
    {
        var counterparty = await db.Counterparties.SingleOrDefaultAsync(c => c.Id == id);
        if (counterparty is null) return EndpointSupport.NotFound("counterparty", id);
        if (counterparty.Status == CounterpartyStatus.Archived) return EndpointSupport.Conflict("An archived counterparty cannot be changed.");
        var errors = EndpointSupport.Validate(request);
        CheckBankDetails(request.BankDetails, errors);
        if (errors.Count > 0) return Results.ValidationProblem(errors);
        if (await db.Counterparties.AnyAsync(c => c.Name == request.Name && c.Id != id && c.Status == CounterpartyStatus.Active))
            return EndpointSupport.Conflict($"An active counterparty named {request.Name} already exists.");
        counterparty.Name = request.Name;
        counterparty.AddressLine = request.Address.Line;
        counterparty.City = request.Address.City;
        counterparty.PostalCode = request.Address.PostalCode;
        counterparty.ContactEmail = request.ContactEmail;
        counterparty.SetBankDetails(request.BankDetails);
        db.Audit("Counterparty", counterparty.Id, "Counterparty.Updated", principal.Email());
        await db.SaveChangesAsync();
        return TypedResults.Ok(counterparty.ToContract());
    }

    /// <summary>Archive counterparty</summary>
    /// <remarks>
    /// Archives a counterparty so it can no longer be paid. Nothing is deleted: payments to it stay readable.
    /// Archiving is refused while payments to the counterparty are still draft, pending approval, approved or scheduled.
    /// </remarks>
    /// <param name="id">The counterparty's ID.</param>
    /// <response code="204">The counterparty was archived.</response>
    /// <response code="404">No counterparty has this ID.</response>
    /// <response code="409">The counterparty is already archived or still has open payments.</response>
    internal static async Task<IResult> Archive(Guid id, TreasuryDbContext db, ClaimsPrincipal principal)
    {
        var counterparty = await db.Counterparties.SingleOrDefaultAsync(c => c.Id == id);
        if (counterparty is null) return EndpointSupport.NotFound("counterparty", id);
        if (counterparty.Status == CounterpartyStatus.Archived) return EndpointSupport.Conflict("The counterparty is already archived.");
        var open = PaymentEndpoints.FundsReserved;
        var pending = await db.Payments.CountAsync(p => p.CounterpartyId == id && open.Contains(p.Status));
        if (pending > 0) return EndpointSupport.Conflict($"{pending} open payment(s) still go to this counterparty. Cancel or complete them first.");
        counterparty.Status = CounterpartyStatus.Archived;
        db.Audit("Counterparty", counterparty.Id, "Counterparty.Archived", principal.Email());
        await db.SaveChangesAsync();
        return Results.NoContent();
    }

    private static void CheckBankDetails(BankDetails details, Dictionary<string, string[]> errors)
    {
        if (details is IbanBankDetails { Iban: { Length: > 0 } iban } && !errors.ContainsKey("bankDetails.iban") && !IbanTools.IsValid(iban))
            errors["bankDetails.iban"] = ["The IBAN's check digits are wrong."];
        if (details is UsAchBankDetails { RoutingNumber.Length: 9 } ach && !errors.ContainsKey("bankDetails.routingNumber") && !IbanTools.IsValidAbaRouting(ach.RoutingNumber))
            errors["bankDetails.routingNumber"] = ["The routing number's checksum is wrong."];
    }
}
