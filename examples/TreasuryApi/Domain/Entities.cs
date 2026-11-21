namespace TreasuryApi;

// Persistence entities. They are mapped to API contracts in Contracts/ and never serialized directly, so the
// database shape can differ from the documented API.

/// <summary>A user in the disposable demo database.</summary>
public sealed class DemoUser
{
    /// <summary>Numeric key.</summary>
    public int Id { get; set; }
    /// <summary>Lower-case sign-in email address.</summary>
    public required string Email { get; set; }
    /// <summary>Display name.</summary>
    public required string Name { get; set; }
    /// <summary>The single role granted to the user: <c>admin</c>, <c>payments.approve</c> or <c>read-only</c>.</summary>
    public required string Role { get; set; }
    /// <summary>Job title shown in the user directory.</summary>
    public string? JobTitle { get; set; }
    /// <summary>Whether the user may sign in.</summary>
    public bool IsActive { get; set; } = true;
    /// <summary>ASP.NET Core Identity password hash.</summary>
    public required string PasswordHash { get; set; }
}

/// <summary>A bank account that Acme entities hold, and from which payments are made.</summary>
public sealed class AccountRecord
{
    /// <summary>Unique ID.</summary>
    public Guid Id { get; set; }
    /// <summary>Short display name, e.g. <c>Operating EUR</c>.</summary>
    public required string Name { get; set; }
    /// <summary>Legal entity that owns the account.</summary>
    public required string Entity { get; set; }
    /// <summary>ISO 3166-1 alpha-2 country of the owning entity.</summary>
    public required string EntityCountry { get; set; }
    /// <summary>Name of the account-holding bank.</summary>
    public required string BankName { get; set; }
    /// <summary>BIC of the account-holding bank.</summary>
    public required string Bic { get; set; }
    /// <summary>IBAN, in its printed four-character grouping.</summary>
    public required string Iban { get; set; }
    /// <summary>Currency of the account.</summary>
    public Currency Currency { get; set; }
    /// <summary>What the account is used for.</summary>
    public AccountType Type { get; set; }
    /// <summary>Whether the account is open for use.</summary>
    public AccountStatus Status { get; set; }
    /// <summary>Ledger balance less funds reserved for unsettled payments.</summary>
    public decimal AvailableBalance { get; set; }
    /// <summary>Booked balance according to the bank ledger.</summary>
    public decimal LedgerBalance { get; set; }
    /// <summary>Date the account was opened.</summary>
    public DateOnly OpenedOn { get; set; }
    /// <summary>Date the account was closed, if it has been.</summary>
    public DateOnly? ClosedOn { get; set; }
    /// <summary>Free-text note about the account.</summary>
    public string? Description { get; set; }
}

/// <summary>A point in an account's intraday balance history.</summary>
public sealed class BalanceSnapshotRecord
{
    /// <summary>Unique ID.</summary>
    public Guid Id { get; set; }
    /// <summary>The account measured.</summary>
    public Guid AccountId { get; set; }
    /// <summary>When the balance was measured.</summary>
    public DateTimeOffset AsOf { get; set; }
    /// <summary>Ledger balance at that time.</summary>
    public decimal Ledger { get; set; }
    /// <summary>Available balance at that time.</summary>
    public decimal Available { get; set; }
}

/// <summary>A supplier, customer, group company or tax authority that Acme pays.</summary>
public sealed class CounterpartyRecord
{
    /// <summary>Unique ID.</summary>
    public Guid Id { get; set; }
    /// <summary>Registered name.</summary>
    public required string Name { get; set; }
    /// <summary>Relationship to Acme.</summary>
    public CounterpartyType Type { get; set; }
    /// <summary>Whether the counterparty can be paid.</summary>
    public CounterpartyStatus Status { get; set; }
    /// <summary>ISO 3166-1 alpha-2 country.</summary>
    public required string Country { get; set; }
    /// <summary>Street address.</summary>
    public required string AddressLine { get; set; }
    /// <summary>City.</summary>
    public required string City { get; set; }
    /// <summary>Postal code.</summary>
    public string? PostalCode { get; set; }
    /// <summary>Contact email for remittance advice.</summary>
    public string? ContactEmail { get; set; }
    /// <summary>The scheme that identifies the bank account.</summary>
    public BankScheme BankScheme { get; set; }
    /// <summary>IBAN, for the IBAN scheme.</summary>
    public string? Iban { get; set; }
    /// <summary>BIC (IBAN scheme: optional; SWIFT scheme: required).</summary>
    public string? Bic { get; set; }
    /// <summary>ABA routing number, for the US ACH scheme.</summary>
    public string? RoutingNumber { get; set; }
    /// <summary>Domestic account number, for the US ACH and SWIFT schemes.</summary>
    public string? AccountNumber { get; set; }
    /// <summary>Name of the counterparty's bank.</summary>
    public string? BankName { get; set; }
    /// <summary>When the record was created.</summary>
    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>A payment persisted by the demo.</summary>
public sealed class PaymentRecord
{
    /// <summary>Unique ID.</summary>
    public Guid Id { get; set; }
    /// <summary>Human-friendly number, e.g. <c>PAY-2026-000123</c>.</summary>
    public required string Number { get; set; }
    /// <summary>Account that is debited.</summary>
    public Guid DebitAccountId { get; set; }
    /// <summary>Beneficiary.</summary>
    public Guid CounterpartyId { get; set; }
    /// <summary>Amount in <see cref="Currency"/>.</summary>
    public decimal Amount { get; set; }
    /// <summary>Currency of the payment, always the debit account's currency.</summary>
    public Currency Currency { get; set; }
    /// <summary>Date the beneficiary should be credited.</summary>
    public DateOnly ValueDate { get; set; }
    /// <summary>Execution urgency.</summary>
    public Priority Priority { get; set; }
    /// <summary>Reference shown on the beneficiary's statement.</summary>
    public string? Reference { get; set; }
    /// <summary>Remittance lines as a JSON array of strings.</summary>
    public string? RemittanceLinesJson { get; set; }
    /// <summary>Who pays bank charges.</summary>
    public ChargeBearer? ChargeBearer { get; set; }
    /// <summary>ISO 20022 purpose code.</summary>
    public PurposeCode? PurposeCode { get; set; }
    /// <summary>The caller's own identifier for the payment.</summary>
    public string? ExternalId { get; set; }
    /// <summary>Lifecycle status.</summary>
    public PaymentStatus Status { get; set; }
    /// <summary>Email of the user who created the payment.</summary>
    public required string CreatedBy { get; set; }
    /// <summary>When the payment was created.</summary>
    public DateTimeOffset CreatedAt { get; set; }
    /// <summary>When the payment last changed.</summary>
    public DateTimeOffset UpdatedAt { get; set; }
    /// <summary>When the payment was submitted for approval.</summary>
    public DateTimeOffset? SubmittedAt { get; set; }
    /// <summary>Why the bank rejected the payment, for failed payments.</summary>
    public string? FailureReason { get; set; }
    /// <summary>The idempotency key used to create the payment.</summary>
    public string? IdempotencyKey { get; set; }
    /// <summary>Hash of the creating request, to detect key reuse with a different body.</summary>
    public string? RequestHash { get; set; }
}

/// <summary>A reviewer's decision on a payment.</summary>
public sealed class PaymentApprovalRecord
{
    /// <summary>Unique ID.</summary>
    public Guid Id { get; set; }
    /// <summary>The reviewed payment.</summary>
    public Guid PaymentId { get; set; }
    /// <summary>Approved or rejected.</summary>
    public ApprovalDecision Decision { get; set; }
    /// <summary>Email of the reviewer.</summary>
    public required string ActorEmail { get; set; }
    /// <summary>Display name of the reviewer.</summary>
    public required string ActorName { get; set; }
    /// <summary>Optional reviewer comment; required when rejecting.</summary>
    public string? Comment { get; set; }
    /// <summary>When the decision was made.</summary>
    public DateTimeOffset DecidedAt { get; set; }
}

/// <summary>A foreign exchange deal booked with a bank.</summary>
public sealed class FxDealRecord
{
    /// <summary>Unique ID.</summary>
    public Guid Id { get; set; }
    /// <summary>Human-friendly number, e.g. <c>FX-2026-0042</c>.</summary>
    public required string Number { get; set; }
    /// <summary>Spot or forward.</summary>
    public FxDealType Type { get; set; }
    /// <summary>The traded pair.</summary>
    public FxPair Pair { get; set; }
    /// <summary>Whether Acme buys or sells the base currency.</summary>
    public FxSide Side { get; set; }
    /// <summary>Amount of the base currency.</summary>
    public decimal BaseAmount { get; set; }
    /// <summary>Amount of the quote currency at the dealt rate.</summary>
    public decimal QuoteAmount { get; set; }
    /// <summary>All-in dealt rate.</summary>
    public decimal Rate { get; set; }
    /// <summary>Forward points included in the rate (zero for spot).</summary>
    public decimal ForwardPoints { get; set; }
    /// <summary>Date the deal was struck.</summary>
    public DateOnly TradeDate { get; set; }
    /// <summary>Date the currencies are exchanged.</summary>
    public DateOnly ValueDate { get; set; }
    /// <summary>Lifecycle status.</summary>
    public FxDealStatus Status { get; set; }
    /// <summary>The dealing bank.</summary>
    public required string Bank { get; set; }
    /// <summary>Email of the dealer.</summary>
    public required string BookedBy { get; set; }
    /// <summary>When the deal was booked.</summary>
    public DateTimeOffset BookedAt { get; set; }
    /// <summary>Why the deal was cancelled.</summary>
    public string? CancelReason { get; set; }
}

/// <summary>A daily bank statement (camt.053 style) for one account.</summary>
public sealed class BankStatementRecord
{
    /// <summary>Unique ID.</summary>
    public Guid Id { get; set; }
    /// <summary>Statement number from the bank.</summary>
    public required string Number { get; set; }
    /// <summary>The account reported.</summary>
    public Guid AccountId { get; set; }
    /// <summary>Currency of the statement.</summary>
    public Currency Currency { get; set; }
    /// <summary>The business day reported.</summary>
    public DateOnly StatementDate { get; set; }
    /// <summary>Booked balance at the start of the day.</summary>
    public decimal OpeningBalance { get; set; }
    /// <summary>Booked balance at the end of the day.</summary>
    public decimal ClosingBalance { get; set; }
    /// <summary>When the bank delivered the statement.</summary>
    public DateTimeOffset ReceivedAt { get; set; }
    /// <summary>The booked entries.</summary>
    public List<StatementEntryRecord> Entries { get; set; } = [];
}

/// <summary>One booked line on a bank statement.</summary>
public sealed class StatementEntryRecord
{
    /// <summary>Unique ID.</summary>
    public Guid Id { get; set; }
    /// <summary>The statement the line belongs to.</summary>
    public Guid StatementId { get; set; }
    /// <summary>Position on the statement, from 1.</summary>
    public int Sequence { get; set; }
    /// <summary>Credit, debit, fee or interest.</summary>
    public StatementEntryType Type { get; set; }
    /// <summary>Always positive; <see cref="Type"/> gives the direction.</summary>
    public decimal Amount { get; set; }
    /// <summary>Date booked by the bank.</summary>
    public DateOnly BookingDate { get; set; }
    /// <summary>Date the funds are available.</summary>
    public DateOnly ValueDate { get; set; }
    /// <summary>Bank-assigned reference.</summary>
    public required string EntryReference { get; set; }
    /// <summary>End-to-end ID, usually the payment number.</summary>
    public string? EndToEndId { get; set; }
    /// <summary>Name of the other party.</summary>
    public string? CounterpartyName { get; set; }
    /// <summary>Remittance text.</summary>
    public string? Remittance { get; set; }
    /// <summary>ISO 20022 bank transaction code, e.g. <c>PMNT-ICDT-ESCT</c>.</summary>
    public required string BankTransactionCode { get; set; }
    /// <summary>The payment this line was reconciled to, if any.</summary>
    public Guid? MatchedPaymentId { get; set; }
}

/// <summary>A local record of a change to a payment or another business object.</summary>
public sealed class AuditEventRecord
{
    /// <summary>Unique ID.</summary>
    public Guid Id { get; set; }
    /// <summary>Kind of object changed, e.g. <c>Payment</c>.</summary>
    public required string EntityType { get; set; }
    /// <summary>ID of the changed object.</summary>
    public required string EntityId { get; set; }
    /// <summary>What happened, e.g. <c>Payment.Created</c>.</summary>
    public required string Action { get; set; }
    /// <summary>Email of the actor.</summary>
    public required string Actor { get; set; }
    /// <summary>When it happened.</summary>
    public DateTimeOffset CreatedAt { get; set; }
}
