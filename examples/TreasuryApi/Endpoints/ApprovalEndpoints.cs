using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using TestBench.AspNetCore;

namespace TreasuryApi;

/// <summary>The approval operations: the queue of payments waiting for review, and the approve and reject decisions.</summary>
internal static class ApprovalEndpoints
{
    internal static void MapApprovalEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v2/approvals").WithTags("Approvals");
        group.MapGet("/", List).WithName("ApprovalsController.List").RequireAuthorization()
            .WithMetadata(new SortKeysMetadata(SortKeys.Approvals)).Produces<PagedList<ApprovalRequest>>().ProducesValidationProblem();
        group.MapPost("/{paymentId:guid}/approve", Approve).WithName("ApprovalsController.Approve").RequireAuthorization(Policies.Writers)
            .Produces<Payment>().ProducesProblem(StatusCodes.Status403Forbidden).ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict).WithTestBenchPreview();
        group.MapPost("/{paymentId:guid}/reject", Reject).WithName("ApprovalsController.Reject").RequireAuthorization(Policies.Writers)
            .Produces<Payment>().ProducesValidationProblem().ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound).ProducesProblem(StatusCodes.Status409Conflict).WithTestBenchPreview();
    }

    /// <summary>List approval queue</summary>
    /// <remarks>
    /// Returns the payments waiting for approval, oldest submission first. Each row says whether **you** can
    /// approve it: nobody can approve a payment they created themselves (the four-eyes rule), and read-only users
    /// can approve nothing. Approve with `ApprovalsController.Approve` or reject with `ApprovalsController.Reject`.
    /// </remarks>
    /// <param name="page">The 1-based page number.</param>
    /// <param name="pageSize">How many requests to return per page, from 1 to 100.</param>
    /// <param name="currency">Only payments in this currency.</param>
    /// <param name="valueDateFrom">Only payments with a value date on or after this date.</param>
    /// <param name="valueDateTo">Only payments with a value date on or before this date.</param>
    /// <param name="minAmount">Only payments of at least this amount.</param>
    /// <param name="q">Search text matched against payment number, reference and counterparty name.</param>
    /// <param name="sort">The sort order: a field name, with a leading minus for descending. Defaults to `submittedAt`.</param>
    /// <response code="200">A page of approval requests.</response>
    /// <response code="400">A paging, sort or filter value was invalid.</response>
    internal static async Task<IResult> List(TreasuryDbContext db, ClaimsPrincipal principal, int page = 1,
        int pageSize = EndpointSupport.DefaultPageSize, Currency? currency = null, DateOnly? valueDateFrom = null,
        DateOnly? valueDateTo = null, decimal? minAmount = null, string? q = null, string? sort = null)
    {
        var errors = new Dictionary<string, string[]>();
        EndpointSupport.CheckPaging(page, pageSize, errors);
        EndpointSupport.CheckSort(sort, SortKeys.Approvals, errors);
        EndpointSupport.CheckRange(valueDateFrom, valueDateTo, nameof(valueDateFrom), nameof(valueDateTo), errors);
        if (errors.Count > 0) return Results.ValidationProblem(errors);

        var query = db.Payments.AsNoTracking().Where(p => p.Status == PaymentStatus.PendingApproval);
        if (currency is { } c) query = query.Where(p => p.Currency == c);
        if (valueDateFrom is { } from) query = query.Where(p => p.ValueDate >= from);
        if (valueDateTo is { } to) query = query.Where(p => p.ValueDate <= to);
        if (minAmount is { } min) query = query.Where(p => p.Amount >= min);
        if (!string.IsNullOrWhiteSpace(q))
        {
            var pattern = EndpointSupport.LikePattern(q);
            query = query.Where(p => EF.Functions.Like(p.Number, pattern, "\\") || EF.Functions.Like(p.Reference!, pattern, "\\") ||
                db.Counterparties.Any(x => x.Id == p.CounterpartyId && EF.Functions.Like(x.Name, pattern, "\\")));
        }
        var ordered = (sort ?? "submittedAt") switch
        {
            "valueDate" => EndpointSupport.Sorted(query, false, p => p.ValueDate, p => p.Id),
            "-valueDate" => EndpointSupport.Sorted(query, true, p => p.ValueDate, p => p.Id),
            "amount" => EndpointSupport.Sorted(query, false, p => p.Amount, p => p.Id),
            "-amount" => EndpointSupport.Sorted(query, true, p => p.Amount, p => p.Id),
            "-submittedAt" => EndpointSupport.Sorted(query, true, p => p.SubmittedAt, p => p.Id),
            _ => EndpointSupport.Sorted(query, false, p => p.SubmittedAt, p => p.Id)
        };
        var me = principal.Email();
        var mayApprove = principal.IsInRole("admin") || principal.IsInRole("payments.approve");
        return TypedResults.Ok(await EndpointSupport.PageAsync(ordered, page, pageSize, async rows =>
        {
            var payments = await rows.ToContractsAsync(db);
            return (IReadOnlyList<ApprovalRequest>)payments.Select(p => new ApprovalRequest
            {
                PaymentId = p.Id, Number = p.Number, Amount = Mapping.Money(p.Amount, p.Currency), ValueDate = p.ValueDate,
                DebitAccount = p.DebitAccount, Counterparty = p.Counterparty, RequestedBy = p.CreatedBy,
                SubmittedAt = p.SubmittedAt ?? p.CreatedAt, CanApprove = mayApprove && !string.Equals(p.CreatedBy.Email, me, StringComparison.OrdinalIgnoreCase)
            }).ToList();
        }));
    }

    /// <summary>Approve payment</summary>
    /// <remarks>
    /// Approves a payment that is `PendingApproval`, which schedules it for release to the bank on its value date.
    ///
    /// **Four-eyes rule:** you cannot approve a payment you created, even as an admin; the answer is 403. Read-only users
    /// are refused with 403 too. Requires the `admin` or `payments.approve` role.
    /// </remarks>
    /// <param name="paymentId">The payment's ID, from `ApprovalsController.List`.</param>
    /// <param name="request">An optional comment for the audit trail.</param>
    /// <response code="200">The approved payment, with the new decision in its `approvals`.</response>
    /// <response code="403">You created this payment yourself, or your role may not approve.</response>
    /// <response code="404">No payment has this ID.</response>
    /// <response code="409">The payment is not waiting for approval.</response>
    internal static Task<IResult> Approve(Guid paymentId, TreasuryDbContext db, ClaimsPrincipal principal,
        DemoNotificationQueue notifications, TestBenchPreview preview, ApprovePaymentRequest? request = null) =>
        Decide(paymentId, ApprovalDecision.Approved, request?.Comment, db, principal, notifications, preview);

    /// <summary>Reject payment</summary>
    /// <remarks>
    /// Rejects a payment that is `PendingApproval` and releases its reservation on the debit account. The creator is
    /// told why, and can revise the payment with `PaymentsController.Update` and submit it again.
    /// The four-eyes rule applies as for approving. Requires the `admin` or `payments.approve` role.
    /// </remarks>
    /// <param name="paymentId">The payment's ID, from `ApprovalsController.List`.</param>
    /// <param name="request">The reason for rejecting.</param>
    /// <response code="200">The rejected payment, with the new decision in its `approvals`.</response>
    /// <response code="400">The reason was missing or too short.</response>
    /// <response code="403">You created this payment yourself, or your role may not reject.</response>
    /// <response code="404">No payment has this ID.</response>
    /// <response code="409">The payment is not waiting for approval.</response>
    internal static async Task<IResult> Reject(Guid paymentId, RejectPaymentRequest request, TreasuryDbContext db,
        ClaimsPrincipal principal, DemoNotificationQueue notifications, TestBenchPreview preview)
    {
        var errors = EndpointSupport.Validate(request);
        if (errors.Count > 0) return Results.ValidationProblem(errors);
        return await Decide(paymentId, ApprovalDecision.Rejected, request.Reason, db, principal, notifications, preview);
    }

    internal static async Task<IResult> Decide(Guid paymentId, ApprovalDecision decision, string? comment, TreasuryDbContext db,
        ClaimsPrincipal principal, DemoNotificationQueue notifications, TestBenchPreview preview)
    {
        var payment = await db.Payments.SingleOrDefaultAsync(p => p.Id == paymentId);
        if (payment is null) return EndpointSupport.NotFound("payment", paymentId);
        if (payment.Status != PaymentStatus.PendingApproval)
            return EndpointSupport.Conflict($"Only payments pending approval can be reviewed; this one is {payment.Status}.");
        if (string.Equals(payment.CreatedBy, principal.Email(), StringComparison.OrdinalIgnoreCase))
            return Results.Problem(title: "Four-eyes rule", statusCode: StatusCodes.Status403Forbidden,
                detail: "You created this payment, so someone else must review it.");
        var approval = new PaymentApprovalRecord
        {
            Id = Guid.NewGuid(), PaymentId = payment.Id, Decision = decision, ActorEmail = principal.Email(),
            ActorName = principal.DisplayName(), Comment = string.IsNullOrWhiteSpace(comment) ? null : comment, DecidedAt = DateTimeOffset.UtcNow
        };
        db.PaymentApprovals.Add(approval);
        payment.Status = decision == ApprovalDecision.Approved ? PaymentStatus.Approved : PaymentStatus.Rejected;
        payment.UpdatedAt = approval.DecidedAt;
        if (decision == ApprovalDecision.Rejected)
            (await db.Accounts.SingleAsync(a => a.Id == payment.DebitAccountId)).AvailableBalance += payment.Amount;
        db.Audit("Payment", payment.Id, $"Payment.{decision}", approval.ActorEmail);
        await db.SaveChangesAsync();
        notifications.PaymentReviewed(payment, approval, preview);
        return TypedResults.Ok(await payment.ToContractAsync(db));
    }
}
