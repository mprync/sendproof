using System.ComponentModel.DataAnnotations;

namespace TreasuryApi;

/// <summary>A payment from an Acme bank account to a counterparty.</summary>
public sealed class Payment
{
    /// <summary>The payment's unique ID.</summary>
    public required Guid Id { get; init; }
    /// <summary>The human-friendly payment number, such as <c>PAY-2026-000123</c>.</summary>
    public required string Number { get; init; }
    /// <summary>Where the payment is in its lifecycle.</summary>
    public required PaymentStatus Status { get; init; }
    /// <summary>The account that is debited.</summary>
    public required AccountReference DebitAccount { get; init; }
    /// <summary>The beneficiary.</summary>
    public required CounterpartyReference Counterparty { get; init; }
    /// <summary>The amount, in the debit account's currency.</summary>
    public required decimal Amount { get; init; }
    /// <summary>The currency of the amount. Always the debit account's currency.</summary>
    public required Currency Currency { get; init; }
    /// <summary>The date the beneficiary should be credited.</summary>
    public required DateOnly ValueDate { get; init; }
    /// <summary>How quickly the bank should execute the payment.</summary>
    public required Priority Priority { get; init; }
    /// <summary>The reference shown on the beneficiary's statement.</summary>
    public string? Reference { get; init; }
    /// <summary>Free-text lines for the beneficiary, such as invoice numbers.</summary>
    public RemittanceInformation? RemittanceInformation { get; init; }
    /// <summary>Who pays the bank charges. Applies to cross-border payments.</summary>
    public ChargeBearer? ChargeBearer { get; init; }
    /// <summary>The ISO 20022 purpose of the payment.</summary>
    public PurposeCode? PurposeCode { get; init; }
    /// <summary>The caller's own identifier for the payment.</summary>
    public string? ExternalId { get; init; }
    /// <summary>The approval decisions made on the payment, oldest first.</summary>
    public required IReadOnlyList<Approval> Approvals { get; init; }
    /// <summary>The person who created the payment.</summary>
    public required ActorReference CreatedBy { get; init; }
    /// <summary>When the payment was created.</summary>
    public required DateTimeOffset CreatedAt { get; init; }
    /// <summary>When the payment last changed.</summary>
    public required DateTimeOffset UpdatedAt { get; init; }
    /// <summary>When the payment was last submitted for approval.</summary>
    public DateTimeOffset? SubmittedAt { get; init; }
    /// <summary>Why the bank could not execute the payment. Present only when it failed.</summary>
    public string? FailureReason { get; init; }
}

/// <summary>Unstructured information that travels with a payment to the beneficiary.</summary>
public sealed class RemittanceInformation
{
    /// <summary>Up to four lines of 140 characters, such as invoice numbers and descriptions.</summary>
    public required IReadOnlyList<string> Lines { get; init; }
    /// <summary>The end-to-end ID the bank carries unchanged to the beneficiary. It is the payment number.</summary>
    public required string EndToEndId { get; init; }
}

/// <summary>A reviewer's decision on a payment.</summary>
public sealed class Approval
{
    /// <summary>The decision's unique ID.</summary>
    public required Guid Id { get; init; }
    /// <summary>Whether the reviewer approved or rejected the payment.</summary>
    public required ApprovalDecision Decision { get; init; }
    /// <summary>The reviewer.</summary>
    public required ActorReference Actor { get; init; }
    /// <summary>The reviewer's comment. Always present for rejections.</summary>
    public string? Comment { get; init; }
    /// <summary>When the decision was made.</summary>
    public required DateTimeOffset DecidedAt { get; init; }
}

/// <summary>Fields used to create a draft payment and reserve its amount.</summary>
public sealed class CreatePaymentRequest
{
    /// <summary>The account to debit. It must be open and hold enough available balance.</summary>
    [Required] public Guid DebitAccountId { get; set; }
    /// <summary>The beneficiary. It must be an active counterparty.</summary>
    [Required] public Guid CounterpartyId { get; set; }
    /// <summary>The amount to pay, in the debit account's currency, to at most two decimal places.</summary>
    [Range(typeof(decimal), "0.01", "999999999999.99")] public decimal Amount { get; set; }
    /// <summary>The ISO 4217 currency of the payment. It must match the debit account's currency.</summary>
    [Required] public string Currency { get; set; } = "EUR";
    /// <summary>The date the beneficiary should be credited. It cannot be in the past.</summary>
    [Required] public DateOnly ValueDate { get; set; }
    /// <summary>How quickly the bank should execute the payment: `Normal`, `Urgent` or `Same day`.</summary>
    public string Priority { get; set; } = "Normal";
    /// <summary>The reference shown on the beneficiary's statement, up to 35 characters.</summary>
    [MaxLength(35)] public string? Reference { get; set; }
    /// <summary>Up to four free-text lines of at most 140 characters for the beneficiary.</summary>
    [MaxLength(4)] public string[]? RemittanceLines { get; set; }
    /// <summary>Who pays the bank charges: `SHA` (shared), `OUR` (the sender) or `BEN` (the beneficiary). Applies to cross-border payments.</summary>
    public string? ChargeBearer { get; set; }
    /// <summary>The four-letter ISO 20022 purpose code, such as <c>SUPP</c> (supplier payment), <c>SALA</c>, <c>TAXS</c>, <c>INTC</c>, <c>TRAD</c>, <c>DIVD</c>, <c>LOAN</c>, <c>RENT</c>, <c>UTIL</c>, <c>INSU</c>, <c>GOVT</c>, <c>PENS</c> or <c>CASH</c>.</summary>
    [RegularExpression("^[A-Z]{4}$")] public string? PurposeCode { get; set; }
    /// <summary>The caller's own identifier for the payment, up to 64 characters.</summary>
    [MaxLength(64)] public string? ExternalId { get; set; }
}

/// <summary>The fields of a draft payment that can still change. The debit account is fixed once created.</summary>
public sealed class UpdatePaymentRequest
{
    /// <summary>The beneficiary. It must be an active counterparty.</summary>
    [Required] public Guid CounterpartyId { get; set; }
    /// <summary>The amount to pay, in the debit account's currency, to at most two decimal places.</summary>
    [Range(typeof(decimal), "0.01", "999999999999.99")] public decimal Amount { get; set; }
    /// <summary>The date the beneficiary should be credited. It cannot be in the past.</summary>
    [Required] public DateOnly ValueDate { get; set; }
    /// <summary>How quickly the bank should execute the payment: `Normal`, `Urgent` or `Same day`.</summary>
    public string Priority { get; set; } = "Normal";
    /// <summary>The reference shown on the beneficiary's statement, up to 35 characters.</summary>
    [MaxLength(35)] public string? Reference { get; set; }
    /// <summary>Up to four free-text lines of at most 140 characters for the beneficiary.</summary>
    [MaxLength(4)] public string[]? RemittanceLines { get; set; }
    /// <summary>Who pays the bank charges: `SHA` (shared), `OUR` (the sender) or `BEN` (the beneficiary).</summary>
    public string? ChargeBearer { get; set; }
    /// <summary>The four-letter ISO 20022 purpose code, such as <c>SUPP</c> or <c>SALA</c>.</summary>
    [RegularExpression("^[A-Z]{4}$")] public string? PurposeCode { get; set; }
    /// <summary>The caller's own identifier for the payment, up to 64 characters.</summary>
    [MaxLength(64)] public string? ExternalId { get; set; }
}

/// <summary>An optional reason for cancelling a payment.</summary>
public sealed class CancelPaymentRequest
{
    /// <summary>Why the payment is being cancelled, up to 200 characters. It is kept in the audit trail.</summary>
    [MaxLength(200)] public string? Reason { get; set; }
}

/// <summary>A payment waiting for a second pair of eyes.</summary>
public sealed class ApprovalRequest
{
    /// <summary>The payment's ID. Pass it to the approve and reject operations.</summary>
    public required Guid PaymentId { get; init; }
    /// <summary>The human-friendly payment number.</summary>
    public required string Number { get; init; }
    /// <summary>The amount and currency to be paid.</summary>
    public required MoneyAmount Amount { get; init; }
    /// <summary>The date the beneficiary should be credited.</summary>
    public required DateOnly ValueDate { get; init; }
    /// <summary>The account that will be debited.</summary>
    public required AccountReference DebitAccount { get; init; }
    /// <summary>The beneficiary.</summary>
    public required CounterpartyReference Counterparty { get; init; }
    /// <summary>The person who asked for approval. They cannot approve their own payment.</summary>
    public required ActorReference RequestedBy { get; init; }
    /// <summary>When approval was requested.</summary>
    public required DateTimeOffset SubmittedAt { get; init; }
    /// <summary>Whether the signed-in user may approve this payment. False for payments they created themselves.</summary>
    public required bool CanApprove { get; init; }
}

/// <summary>A reviewer's optional comment when approving.</summary>
public sealed class ApprovePaymentRequest
{
    /// <summary>A comment for the audit trail, up to 500 characters.</summary>
    [MaxLength(500)] public string? Comment { get; set; }
}

/// <summary>The reason for rejecting a payment.</summary>
public sealed class RejectPaymentRequest
{
    /// <summary>Why the payment is rejected, 5 to 500 characters. The creator sees it and can revise the draft.</summary>
    [Required, StringLength(500, MinimumLength = 5)] public string Reason { get; set; } = "";
}
