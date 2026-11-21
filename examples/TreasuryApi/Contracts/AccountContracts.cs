using System.ComponentModel.DataAnnotations;

namespace TreasuryApi;

/// <summary>A bank account held by an Acme legal entity.</summary>
public sealed class Account
{
    /// <summary>The account's unique ID.</summary>
    public required Guid Id { get; init; }
    /// <summary>Short display name, such as <c>Operating EUR</c>.</summary>
    public required string Name { get; init; }
    /// <summary>The legal entity that owns the account.</summary>
    public required string Entity { get; init; }
    /// <summary>The ISO 3166-1 alpha-2 country of the owning entity.</summary>
    public required string EntityCountry { get; init; }
    /// <summary>The name of the bank that holds the account.</summary>
    public required string BankName { get; init; }
    /// <summary>The BIC (SWIFT code) of the bank.</summary>
    public required string Bic { get; init; }
    /// <summary>The IBAN in its printed four-character grouping.</summary>
    public required string Iban { get; init; }
    /// <summary>The currency the account is held in.</summary>
    public required Currency Currency { get; init; }
    /// <summary>What the account is used for.</summary>
    public required AccountType Type { get; init; }
    /// <summary>Whether the account is open, frozen by the bank or closed.</summary>
    public required AccountStatus Status { get; init; }
    /// <summary>The ledger balance less funds reserved for payments that have not yet settled.</summary>
    public required decimal AvailableBalance { get; init; }
    /// <summary>The booked balance according to the bank's ledger.</summary>
    public required decimal LedgerBalance { get; init; }
    /// <summary>The date the account was opened.</summary>
    public required DateOnly OpenedOn { get; init; }
    /// <summary>The date the account was closed. Absent while the account is open.</summary>
    public DateOnly? ClosedOn { get; init; }
    /// <summary>A free-text note about the account's purpose.</summary>
    public string? Description { get; init; }
}

/// <summary>Fields used to register a new bank account.</summary>
public sealed class CreateAccountRequest
{
    /// <summary>Short display name, unique across accounts.</summary>
    [Required, StringLength(60, MinimumLength = 3)] public string Name { get; set; } = "";
    /// <summary>The legal entity that owns the account.</summary>
    [Required, StringLength(80, MinimumLength = 2)] public string Entity { get; set; } = "";
    /// <summary>The ISO 3166-1 alpha-2 country of the owning entity.</summary>
    [Required, RegularExpression("^[A-Z]{2}$")] public string EntityCountry { get; set; } = "";
    /// <summary>The name of the bank that holds the account.</summary>
    [Required, StringLength(80, MinimumLength = 2)] public string BankName { get; set; } = "";
    /// <summary>The BIC of the bank: 8 or 11 characters.</summary>
    [Required, RegularExpression("^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$")] public string Bic { get; set; } = "";
    /// <summary>The IBAN, with or without spaces. Its check digits are verified.</summary>
    [Required, RegularExpression("^[A-Z]{2}[0-9]{2}[A-Z0-9 ]{11,32}$")] public string Iban { get; set; } = "";
    /// <summary>The currency the account is held in.</summary>
    [Required] public Currency Currency { get; set; } = Currency.EUR;
    /// <summary>What the account is used for.</summary>
    [Required] public AccountType Type { get; set; } = AccountType.Operating;
    /// <summary>A free-text note about the account's purpose.</summary>
    [MaxLength(200)] public string? Description { get; set; }
}

/// <summary>The mutable fields of a bank account.</summary>
public sealed class UpdateAccountRequest
{
    /// <summary>Short display name, unique across accounts.</summary>
    [Required, StringLength(60, MinimumLength = 3)] public string Name { get; set; } = "";
    /// <summary>A free-text note about the account's purpose.</summary>
    [MaxLength(200)] public string? Description { get; set; }
    /// <summary>Set to <c>Frozen</c> to block new payments, or <c>Open</c> to allow them. Use the close operation to close an account.</summary>
    public AccountStatus Status { get; set; } = AccountStatus.Open;
}

/// <summary>The current balance of an account.</summary>
public sealed class AccountBalance
{
    /// <summary>The account measured.</summary>
    public required AccountReference Account { get; init; }
    /// <summary>The booked balance according to the bank's ledger.</summary>
    public required decimal LedgerBalance { get; init; }
    /// <summary>The ledger balance less funds reserved for unsettled payments.</summary>
    public required decimal AvailableBalance { get; init; }
    /// <summary>Funds reserved for payments that are drafted, pending approval, approved or scheduled.</summary>
    public required decimal ReservedAmount { get; init; }
    /// <summary>When the balance was last updated.</summary>
    public required DateTimeOffset AsOf { get; init; }
}

/// <summary>The balance of an account at a point in time.</summary>
public sealed class BalancePoint
{
    /// <summary>When the balance was measured.</summary>
    public required DateTimeOffset AsOf { get; init; }
    /// <summary>The booked balance at that time.</summary>
    public required decimal LedgerBalance { get; init; }
    /// <summary>The available balance at that time.</summary>
    public required decimal AvailableBalance { get; init; }
}

/// <summary>The balance as returned by the deprecated balance operation.</summary>
public sealed class LegacyAccountBalance
{
    /// <summary>The account's ID.</summary>
    public required Guid AccountId { get; init; }
    /// <summary>The available balance. Use the balances operations for the ledger balance too.</summary>
    public required decimal Balance { get; init; }
    /// <summary>The currency of the balance.</summary>
    public required Currency Currency { get; init; }
}
