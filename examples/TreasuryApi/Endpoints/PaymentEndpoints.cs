using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Sendproof.AspNetCore;

namespace TreasuryApi;

/// <summary>The payment operations: list, read, create, revise, submit and cancel.</summary>
internal static class PaymentEndpoints
{
    /// <summary>Statuses in which a payment still holds a reservation on its debit account.</summary>
    internal static readonly PaymentStatus[] FundsReserved =
        [PaymentStatus.Draft, PaymentStatus.PendingApproval, PaymentStatus.Approved, PaymentStatus.Scheduled];

    internal static void MapPaymentEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v2/payments").WithTags("Payments");
        group.MapGet("/", List).WithName("PaymentsController.List").RequireAuthorization()
            .WithMetadata(new SortKeysMetadata(SortKeys.Payments))
            .Produces<PagedList<Payment>>().ProducesValidationProblem();
        group.MapGet("/{id:guid}", Get).WithName("PaymentsController.Get").RequireAuthorization()
            .Produces<Payment>().ProducesProblem(StatusCodes.Status404NotFound);
        group.MapPost("/", Create).WithName("PaymentsController.Create").RequireAuthorization(Policies.Writers)
            .Produces<Payment>(StatusCodes.Status201Created).Produces<Payment>(StatusCodes.Status200OK)
            .ProducesValidationProblem().ProducesProblem(StatusCodes.Status409Conflict).WithSendproofPreview();
        group.MapPut("/{id:guid}", Update).WithName("PaymentsController.Update").RequireAuthorization(Policies.Writers)
            .Produces<Payment>().ProducesValidationProblem().ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict).WithSendproofPreview();
        group.MapPost("/{id:guid}/submit", Submit).WithName("PaymentsController.Submit").RequireAuthorization(Policies.Writers)
            .Produces<Payment>().ProducesProblem(StatusCodes.Status404NotFound).ProducesProblem(StatusCodes.Status409Conflict)
            .WithSendproofPreview();
        group.MapPost("/{id:guid}/cancel", Cancel).WithName("PaymentsController.Cancel").RequireAuthorization(Policies.Writers)
            .Produces<Payment>().ProducesProblem(StatusCodes.Status404NotFound).ProducesProblem(StatusCodes.Status409Conflict)
            .WithSendproofPreview();
    }

    /// <summary>List payments</summary>
    /// <remarks>
    /// Returns payments in every status, newest first unless you pass `sort`.
    ///
    /// - Combine filters freely: `status=PendingApproval&amp;currency=EUR` lists euro payments waiting for review.
    /// - `q` searches the payment number, reference, external ID and the counterparty's name.
    /// - Use `reference` to find payments you created, for example after a Send.
    ///
    /// Open a payment with `PaymentsController.Get`; create one with `PaymentsController.Create`.
    /// </remarks>
    /// <param name="page">The 1-based page number.</param>
    /// <param name="pageSize">How many payments to return per page, from 1 to 100.</param>
    /// <param name="status">Only payments in this status.</param>
    /// <param name="currency">Only payments in this currency.</param>
    /// <param name="debitAccountId">Only payments debited from this account.</param>
    /// <param name="counterpartyId">Only payments to this counterparty.</param>
    /// <param name="valueDateFrom">Only payments with a value date on or after this date.</param>
    /// <param name="valueDateTo">Only payments with a value date on or before this date.</param>
    /// <param name="minAmount">Only payments of at least this amount.</param>
    /// <param name="maxAmount">Only payments of at most this amount.</param>
    /// <param name="reference">Only payments whose reference contains this text.</param>
    /// <param name="q">Search text matched against number, reference, external ID and counterparty name.</param>
    /// <param name="sort">The sort order: a field name, with a leading minus for descending. Defaults to `-createdAt`.</param>
    /// <response code="200">A page of payments.</response>
    /// <response code="400">A paging, sort or filter value was invalid.</response>
    internal static async Task<IResult> List(TreasuryDbContext db, int page = 1, int pageSize = EndpointSupport.DefaultPageSize,
        PaymentStatus? status = null, Currency? currency = null, Guid? debitAccountId = null, Guid? counterpartyId = null,
        DateOnly? valueDateFrom = null, DateOnly? valueDateTo = null, decimal? minAmount = null, decimal? maxAmount = null,
        string? reference = null, string? q = null, string? sort = null)
    {
        var errors = new Dictionary<string, string[]>();
        EndpointSupport.CheckPaging(page, pageSize, errors);
        EndpointSupport.CheckSort(sort, SortKeys.Payments, errors);
        EndpointSupport.CheckRange(valueDateFrom, valueDateTo, nameof(valueDateFrom), nameof(valueDateTo), errors);
        if (errors.Count > 0) return Results.ValidationProblem(errors);

        var query = db.Payments.AsNoTracking().AsQueryable();
        if (status is { } s) query = query.Where(p => p.Status == s);
        if (currency is { } c) query = query.Where(p => p.Currency == c);
        if (debitAccountId is { } a) query = query.Where(p => p.DebitAccountId == a);
        if (counterpartyId is { } cp) query = query.Where(p => p.CounterpartyId == cp);
        if (valueDateFrom is { } from) query = query.Where(p => p.ValueDate >= from);
        if (valueDateTo is { } to) query = query.Where(p => p.ValueDate <= to);
        if (minAmount is { } min) query = query.Where(p => p.Amount >= min);
        if (maxAmount is { } max) query = query.Where(p => p.Amount <= max);
        if (!string.IsNullOrWhiteSpace(reference)) query = query.Where(p => EF.Functions.Like(p.Reference!, EndpointSupport.LikePattern(reference), "\\"));
        if (!string.IsNullOrWhiteSpace(q))
        {
            var pattern = EndpointSupport.LikePattern(q);
            query = query.Where(p => EF.Functions.Like(p.Number, pattern, "\\") || EF.Functions.Like(p.Reference!, pattern, "\\") ||
                EF.Functions.Like(p.ExternalId!, pattern, "\\") ||
                db.Counterparties.Any(x => x.Id == p.CounterpartyId && EF.Functions.Like(x.Name, pattern, "\\")));
        }
        var ordered = (sort ?? "-createdAt") switch
        {
            "valueDate" => EndpointSupport.Sorted(query, false, p => p.ValueDate, p => p.Id),
            "-valueDate" => EndpointSupport.Sorted(query, true, p => p.ValueDate, p => p.Id),
            "amount" => EndpointSupport.Sorted(query, false, p => p.Amount, p => p.Id),
            "-amount" => EndpointSupport.Sorted(query, true, p => p.Amount, p => p.Id),
            "number" => EndpointSupport.Sorted(query, false, p => p.Number, p => p.Id),
            "-number" => EndpointSupport.Sorted(query, true, p => p.Number, p => p.Id),
            "createdAt" => EndpointSupport.Sorted(query, false, p => p.CreatedAt, p => p.Id),
            _ => EndpointSupport.Sorted(query, true, p => p.CreatedAt, p => p.Id)
        };
        return TypedResults.Ok(await EndpointSupport.PageAsync(ordered, page, pageSize, async rows => await rows.ToContractsAsync(db)));
    }

    /// <summary>Get payment</summary>
    /// <remarks>Returns one payment with its debit account, counterparty and approval history.</remarks>
    /// <param name="id">The payment's ID, from `PaymentsController.List` or the response of `PaymentsController.Create`.</param>
    /// <response code="200">The payment.</response>
    /// <response code="404">No payment has this ID.</response>
    internal static async Task<IResult> Get(Guid id, TreasuryDbContext db) =>
        await db.Payments.AsNoTracking().SingleOrDefaultAsync(p => p.Id == id) is { } payment
            ? TypedResults.Ok(await payment.ToContractAsync(db))
            : EndpointSupport.NotFound("payment", id);

    /// <summary>Create payment</summary>
    /// <remarks>
    /// Creates a **draft** payment and reserves its amount on the debit account, so the account's available
    /// balance drops immediately. The payment is not sent to the bank until it has been submitted with
    /// `PaymentsController.Submit` and approved by someone else.
    ///
    /// Send an `Idempotency-Key` header to make retries safe: repeating the same request with the same key returns
    /// the original payment with status 200, and reusing the key with a different body fails with 409.
    ///
    /// Requires the `admin` or `payments.approve` role. Preview shows the database changes, the notification and
    /// the SQL without keeping any of it.
    /// </remarks>
    /// <param name="request">The payment to create.</param>
    /// <param name="idempotencyKey">A unique key for this request, up to 128 characters. Generate a UUID for each new payment.</param>
    /// <response code="201">The draft payment was created. The `Location` header points to it.</response>
    /// <response code="200">The idempotency key was used before with the same request; the original payment is returned.</response>
    /// <response code="400">A field was missing or invalid. The `errors` object names each one.</response>
    /// <response code="409">The idempotency key was already used for a different request.</response>
    internal static async Task<IResult> Create(CreatePaymentRequest request,
        [FromHeader(Name = "Idempotency-Key")] string? idempotencyKey,
        TreasuryDbContext db, System.Security.Claims.ClaimsPrincipal principal, DemoNotificationQueue notifications, SendproofPreview preview)
    {
        var errors = EndpointSupport.Validate(request);
        if (idempotencyKey?.Length > 128)
            errors["Idempotency-Key"] = ["The idempotency key must be at most 128 characters."];
        var requestHash = Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(request)));
        if (!string.IsNullOrWhiteSpace(idempotencyKey))
        {
            var existing = await db.Payments.SingleOrDefaultAsync(p => p.IdempotencyKey == idempotencyKey);
            if (existing is not null)
                return existing.RequestHash == requestHash
                    ? TypedResults.Ok(await existing.ToContractAsync(db))
                    : EndpointSupport.Conflict("Idempotency key was already used for a different request.");
        }
        var account = await db.Accounts.SingleOrDefaultAsync(a => a.Id == request.DebitAccountId);
        if (account is null) errors["debitAccountId"] = ["Choose an existing debit account."];
        else if (account.Status != AccountStatus.Open) errors["debitAccountId"] = [$"The debit account is {account.Status.ToString().ToLowerInvariant()}."];
        var counterparty = await db.Counterparties.SingleOrDefaultAsync(c => c.Id == request.CounterpartyId);
        if (counterparty is null) errors["counterpartyId"] = ["Choose an existing counterparty."];
        else if (counterparty.Status != CounterpartyStatus.Active) errors["counterpartyId"] = ["The counterparty is archived and cannot be paid."];
        var currency = ParseCurrency(request.Currency);
        if (currency is null) errors["currency"] = [$"Use one of: {string.Join(", ", Enum.GetNames<Currency>())}."];
        if (account is not null && currency is not null) CheckAmountAndCurrency(request.Amount, currency.Value, account, null, errors);
        var priority = ParsePriority(request.Priority);
        if (priority is null) errors["priority"] = ["Use Normal, Urgent or Same day."];
        var chargeBearer = ParseChargeBearer(request.ChargeBearer);
        if (request.ChargeBearer is not null && chargeBearer is null) errors["chargeBearer"] = ["Use SHA, OUR or BEN."];
        CheckValueDate(request.ValueDate, errors);
        CheckTexts(request.RemittanceLines, request.PurposeCode, errors);
        if (errors.Count > 0) return Results.ValidationProblem(errors);

        account!.AvailableBalance -= request.Amount;
        var now = DateTimeOffset.UtcNow;
        var payment = new PaymentRecord
        {
            Id = Guid.NewGuid(), Number = await NextNumberAsync(db), DebitAccountId = account.Id, CounterpartyId = request.CounterpartyId,
            Amount = request.Amount, Currency = account.Currency, ValueDate = request.ValueDate,
            Priority = priority!.Value, Reference = request.Reference, Status = PaymentStatus.Draft,
            RemittanceLinesJson = request.RemittanceLines is null ? null : JsonSerializer.Serialize(request.RemittanceLines),
            ChargeBearer = chargeBearer, PurposeCode = ParsePurpose(request.PurposeCode), ExternalId = request.ExternalId,
            CreatedBy = principal.Email(), CreatedAt = now, UpdatedAt = now,
            IdempotencyKey = string.IsNullOrWhiteSpace(idempotencyKey) ? null : idempotencyKey,
            RequestHash = requestHash
        };
        db.Payments.Add(payment);
        db.Audit("Payment", payment.Id, "Payment.Created", payment.CreatedBy);
        await db.SaveChangesAsync();
        notifications.PaymentCreated(payment.Id, preview);
        return TypedResults.Created($"/api/v2/payments/{payment.Id}", await payment.ToContractAsync(db));
    }

    /// <summary>Update draft payment</summary>
    /// <remarks>
    /// Revises a payment that is still a **draft**, or one that was **rejected** (which returns it to draft so it
    /// can be submitted again). The reservation on the debit account is adjusted to the new amount.
    /// The debit account cannot change; cancel the payment and create a new one instead.
    /// </remarks>
    /// <param name="id">The payment's ID.</param>
    /// <param name="request">The new values. Every field is replaced.</param>
    /// <response code="200">The revised payment.</response>
    /// <response code="400">A field was invalid.</response>
    /// <response code="404">No payment has this ID.</response>
    /// <response code="409">The payment is no longer a draft, so it cannot be edited.</response>
    internal static async Task<IResult> Update(Guid id, UpdatePaymentRequest request, TreasuryDbContext db,
        System.Security.Claims.ClaimsPrincipal principal)
    {
        var payment = await db.Payments.SingleOrDefaultAsync(p => p.Id == id);
        if (payment is null) return EndpointSupport.NotFound("payment", id);
        if (payment.Status is not (PaymentStatus.Draft or PaymentStatus.Rejected))
            return EndpointSupport.Conflict($"Only draft or rejected payments can be edited; this one is {payment.Status}.");
        var errors = EndpointSupport.Validate(request);
        var account = await db.Accounts.SingleAsync(a => a.Id == payment.DebitAccountId);
        var counterparty = await db.Counterparties.SingleOrDefaultAsync(c => c.Id == request.CounterpartyId);
        if (counterparty is null) errors["counterpartyId"] = ["Choose an existing counterparty."];
        else if (counterparty.Status != CounterpartyStatus.Active) errors["counterpartyId"] = ["The counterparty is archived and cannot be paid."];
        CheckAmountAndCurrency(request.Amount, payment.Currency, account, payment.Status == PaymentStatus.Draft ? payment.Amount : 0m, errors);
        var priority = ParsePriority(request.Priority);
        if (priority is null) errors["priority"] = ["Use Normal, Urgent or Same day."];
        var chargeBearer = ParseChargeBearer(request.ChargeBearer);
        if (request.ChargeBearer is not null && chargeBearer is null) errors["chargeBearer"] = ["Use SHA, OUR or BEN."];
        CheckValueDate(request.ValueDate, errors);
        CheckTexts(request.RemittanceLines, request.PurposeCode, errors);
        if (errors.Count > 0) return Results.ValidationProblem(errors);

        account.AvailableBalance += (payment.Status == PaymentStatus.Draft ? payment.Amount : 0m) - request.Amount;
        payment.CounterpartyId = request.CounterpartyId;
        payment.Amount = request.Amount;
        payment.ValueDate = request.ValueDate;
        payment.Priority = priority!.Value;
        payment.Reference = request.Reference;
        payment.RemittanceLinesJson = request.RemittanceLines is null ? null : JsonSerializer.Serialize(request.RemittanceLines);
        payment.ChargeBearer = chargeBearer;
        payment.PurposeCode = ParsePurpose(request.PurposeCode);
        payment.ExternalId = request.ExternalId;
        payment.Status = PaymentStatus.Draft;
        payment.UpdatedAt = DateTimeOffset.UtcNow;
        db.Audit("Payment", payment.Id, "Payment.Updated", principal.Email());
        await db.SaveChangesAsync();
        return TypedResults.Ok(await payment.ToContractAsync(db));
    }

    /// <summary>Submit payment for approval</summary>
    /// <remarks>
    /// Moves a **draft** to `PendingApproval` and notifies the approvers. A different approver must then approve it with
    /// `ApprovalsController.Approve` (the four-eyes rule). The payment appears in `ApprovalsController.List`.
    /// </remarks>
    /// <param name="id">The payment's ID.</param>
    /// <response code="200">The payment, now pending approval.</response>
    /// <response code="404">No payment has this ID.</response>
    /// <response code="409">Only draft payments can be submitted.</response>
    internal static async Task<IResult> Submit(Guid id, TreasuryDbContext db, System.Security.Claims.ClaimsPrincipal principal,
        DemoNotificationQueue notifications, SendproofPreview preview)
    {
        var payment = await db.Payments.SingleOrDefaultAsync(p => p.Id == id);
        if (payment is null) return EndpointSupport.NotFound("payment", id);
        if (payment.Status != PaymentStatus.Draft)
            return EndpointSupport.Conflict($"Only draft payments can be submitted; this one is {payment.Status}.");
        if (payment.ValueDate < DateOnly.FromDateTime(DateTime.UtcNow))
            return EndpointSupport.Unprocessable("The value date has passed. Update the draft with a new value date first.");
        var now = DateTimeOffset.UtcNow;
        payment.Status = PaymentStatus.PendingApproval;
        payment.SubmittedAt = payment.UpdatedAt = now;
        db.Audit("Payment", payment.Id, "Payment.Submitted", principal.Email());
        await db.SaveChangesAsync();
        var approvers = await db.Users.AsNoTracking()
            .Where(u => u.IsActive && (u.Role == "payments.approve" || u.Role == "admin") && u.Email != payment.CreatedBy)
            .Select(u => u.Email).ToListAsync();
        notifications.PaymentSubmitted(payment, approvers, preview);
        return TypedResults.Ok(await payment.ToContractAsync(db));
    }

    /// <summary>Cancel payment</summary>
    /// <remarks>
    /// Cancels a payment that has not been sent to the bank (draft, pending approval, approved, scheduled or
    /// rejected) and releases its reservation on the debit account. Payments already sent, settled or failed cannot be cancelled.
    /// </remarks>
    /// <param name="id">The payment's ID.</param>
    /// <param name="request">An optional reason, kept in the audit trail.</param>
    /// <response code="200">The cancelled payment.</response>
    /// <response code="404">No payment has this ID.</response>
    /// <response code="409">The payment is already with the bank or finished, so it cannot be cancelled.</response>
    internal static async Task<IResult> Cancel(Guid id, TreasuryDbContext db, System.Security.Claims.ClaimsPrincipal principal,
        DemoNotificationQueue notifications, SendproofPreview preview, [FromBody] CancelPaymentRequest? request = null)
    {
        var payment = await db.Payments.SingleOrDefaultAsync(p => p.Id == id);
        if (payment is null) return EndpointSupport.NotFound("payment", id);
        if (payment.Status is PaymentStatus.Sent or PaymentStatus.Settled or PaymentStatus.Failed or PaymentStatus.Cancelled)
            return EndpointSupport.Conflict($"A {payment.Status} payment cannot be cancelled.");
        if (FundsReserved.Contains(payment.Status))
            (await db.Accounts.SingleAsync(a => a.Id == payment.DebitAccountId)).AvailableBalance += payment.Amount;
        payment.Status = PaymentStatus.Cancelled;
        payment.UpdatedAt = DateTimeOffset.UtcNow;
        db.Audit("Payment", payment.Id, request?.Reason is { Length: > 0 } reason ? $"Payment.Cancelled: {reason}" : "Payment.Cancelled", principal.Email());
        await db.SaveChangesAsync();
        notifications.PaymentCancelled(payment, preview);
        return TypedResults.Ok(await payment.ToContractAsync(db));
    }

    /// <summary>Checks amount, scale and balance against the debit account; <paramref name="alreadyReserved"/> is added back first.</summary>
    private static void CheckAmountAndCurrency(decimal amount, Currency currency, AccountRecord account, decimal? alreadyReserved,
        Dictionary<string, string[]> errors)
    {
        if (amount < 0.01m) errors["amount"] = ["Amount must be at least 0.01."];
        else if (EndpointSupport.HasTooManyDecimals(amount, account.Currency))
            errors["amount"] = [$"{account.Currency} amounts allow at most {EndpointSupport.Decimals(account.Currency)} decimal places."];
        else if (amount > account.AvailableBalance + (alreadyReserved ?? 0m)) errors["amount"] = ["Amount exceeds the available balance."];
        if (account.Currency != currency) errors["currency"] = ["Currency must match the debit account."];
    }

    private static void CheckValueDate(DateOnly valueDate, Dictionary<string, string[]> errors)
    {
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        if (valueDate == default || valueDate < today) errors["valueDate"] = ["Value date must be today or later."];
        else if (valueDate > today.AddDays(365)) errors["valueDate"] = ["Value date must be within the next 365 days."];
    }

    private static void CheckTexts(string[]? remittanceLines, string? purposeCode, Dictionary<string, string[]> errors)
    {
        if (remittanceLines?.Any(line => line.Length > 140) == true)
            errors["remittanceLines"] = ["Each remittance line must be at most 140 characters."];
        if (purposeCode is not null && ParsePurpose(purposeCode) is null)
            errors["purposeCode"] = [$"Use one of: {string.Join(", ", Enum.GetNames<PurposeCode>())}."];
    }

    private static Currency? ParseCurrency(string? code) =>
        Enum.TryParse<Currency>(code, ignoreCase: false, out var value) && Enum.IsDefined(value) ? value : null;

    private static Priority? ParsePriority(string? text) => text switch
    {
        "Normal" => Priority.Normal,
        "Urgent" => Priority.Urgent,
        "Same day" => Priority.SameDay,
        _ => null
    };

    private static ChargeBearer? ParseChargeBearer(string? text) =>
        Enum.TryParse<ChargeBearer>(text, ignoreCase: false, out var value) && Enum.IsDefined(value) ? value : null;

    private static PurposeCode? ParsePurpose(string? code) =>
        Enum.TryParse<PurposeCode>(code, out var value) && Enum.IsDefined(value) ? value : null;

    /// <summary>Allocates the next payment number of the current year, such as <c>PAY-2026-000123</c>.</summary>
    internal static async Task<string> NextNumberAsync(TreasuryDbContext db)
    {
        var prefix = $"PAY-{DateTime.UtcNow.Year}-";
        var last = await db.Payments.AsNoTracking().Where(p => p.Number.StartsWith(prefix)).OrderByDescending(p => p.Number)
            .Select(p => p.Number).FirstOrDefaultAsync();
        var next = last is null ? 1 : int.Parse(last[prefix.Length..]) + 1;
        return $"{prefix}{next:000000}";
    }
}
