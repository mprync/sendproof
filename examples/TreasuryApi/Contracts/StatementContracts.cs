namespace TreasuryApi;

/// <summary>The header of a daily bank statement, as listed.</summary>
public class BankStatementSummary
{
    /// <summary>The statement's unique ID.</summary>
    public required Guid Id { get; init; }
    /// <summary>The statement number assigned by the bank.</summary>
    public required string Number { get; init; }
    /// <summary>The account the statement reports on.</summary>
    public required AccountReference Account { get; init; }
    /// <summary>The business day the statement covers.</summary>
    public required DateOnly StatementDate { get; init; }
    /// <summary>The booked balance at the start of the day.</summary>
    public required MoneyAmount OpeningBalance { get; init; }
    /// <summary>The booked balance at the end of the day. It equals the opening balance plus credits and interest, less debits and fees.</summary>
    public required MoneyAmount ClosingBalance { get; init; }
    /// <summary>How many entries the statement holds.</summary>
    public required int EntryCount { get; init; }
    /// <summary>When the bank delivered the statement.</summary>
    public required DateTimeOffset ReceivedAt { get; init; }
}

/// <summary>A daily bank statement with all of its entries, in the style of ISO 20022 camt.053.</summary>
public sealed class BankStatement : BankStatementSummary
{
    /// <summary>The booked entries, in the order the bank reported them.</summary>
    public required IReadOnlyList<StatementEntry> Entries { get; init; }
}

/// <summary>One booked line on a bank statement.</summary>
public sealed class StatementEntry
{
    /// <summary>The entry's unique ID.</summary>
    public required Guid Id { get; init; }
    /// <summary>The position on the statement, starting at 1.</summary>
    public required int Sequence { get; init; }
    /// <summary>Whether the entry is a credit, debit, fee or interest.</summary>
    public required StatementEntryType Type { get; init; }
    /// <summary>The amount. Always positive; the type gives the direction.</summary>
    public required MoneyAmount Amount { get; init; }
    /// <summary>The date the bank booked the entry.</summary>
    public required DateOnly BookingDate { get; init; }
    /// <summary>The date the funds are available.</summary>
    public required DateOnly ValueDate { get; init; }
    /// <summary>The bank's reference for the entry.</summary>
    public required string EntryReference { get; init; }
    /// <summary>The end-to-end ID, which for payments made here is the payment number.</summary>
    public string? EndToEndId { get; init; }
    /// <summary>The name of the other party.</summary>
    public string? CounterpartyName { get; init; }
    /// <summary>The remittance text the other party supplied.</summary>
    public string? Remittance { get; init; }
    /// <summary>The ISO 20022 bank transaction code, such as <c>PMNT-ICDT-ESCT</c> for a SEPA credit transfer.</summary>
    public required string BankTransactionCode { get; init; }
    /// <summary>The payment this entry was reconciled to. Absent for unmatched entries.</summary>
    public Guid? MatchedPaymentId { get; init; }
}
