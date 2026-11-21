using System.ComponentModel.DataAnnotations;
using System.Text.Json.Serialization;

namespace TreasuryApi;

/// <summary>
/// How a counterparty's bank account is identified. The <c>scheme</c> property selects the variant:
/// <c>Iban</c> for SEPA and most of the world, <c>UsAch</c> for US domestic accounts and <c>Swift</c> for
/// other international accounts.
/// </summary>
[JsonPolymorphic(TypeDiscriminatorPropertyName = "scheme")]
[JsonDerivedType(typeof(IbanBankDetails), "Iban")]
[JsonDerivedType(typeof(UsAchBankDetails), "UsAch")]
[JsonDerivedType(typeof(SwiftBankDetails), "Swift")]
public abstract class BankDetails
{
    /// <summary>A printable identifier of the account, used to recognise it in lists.</summary>
    internal abstract string DisplayIdentifier { get; }
}

/// <summary>A bank account identified by IBAN.</summary>
public sealed class IbanBankDetails : BankDetails
{
    /// <summary>The IBAN, with or without spaces. Its check digits are verified.</summary>
    [Required, RegularExpression("^[A-Z]{2}[0-9]{2}[A-Z0-9 ]{11,32}$")] public string Iban { get; set; } = "";
    /// <summary>The BIC of the beneficiary bank. Optional within SEPA.</summary>
    [RegularExpression("^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$")] public string? Bic { get; set; }
    /// <inheritdoc />
    internal override string DisplayIdentifier => Iban;
}

/// <summary>A US domestic bank account, paid over the ACH network.</summary>
public sealed class UsAchBankDetails : BankDetails
{
    /// <summary>The nine-digit ABA routing number of the bank.</summary>
    [Required, RegularExpression("^[0-9]{9}$")] public string RoutingNumber { get; set; } = "";
    /// <summary>The account number, 4 to 17 digits.</summary>
    [Required, RegularExpression("^[0-9]{4,17}$")] public string AccountNumber { get; set; } = "";
    /// <summary>The name of the beneficiary bank.</summary>
    [MaxLength(80)] public string? BankName { get; set; }
    /// <inheritdoc />
    internal override string DisplayIdentifier => $"{RoutingNumber} / {AccountNumber}";
}

/// <summary>An international bank account identified by BIC and a local account number.</summary>
public sealed class SwiftBankDetails : BankDetails
{
    /// <summary>The BIC (SWIFT code) of the beneficiary bank.</summary>
    [Required, RegularExpression("^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$")] public string Bic { get; set; } = "";
    /// <summary>The account number in the bank's local format, up to 34 characters.</summary>
    [Required, StringLength(34, MinimumLength = 4)] public string AccountNumber { get; set; } = "";
    /// <summary>The name of the beneficiary bank.</summary>
    [MaxLength(80)] public string? BankName { get; set; }
    /// <inheritdoc />
    internal override string DisplayIdentifier => $"{Bic} / {AccountNumber}";
}

/// <summary>A supplier, customer, group company or tax authority that Acme pays.</summary>
public sealed class Counterparty
{
    /// <summary>The counterparty's unique ID.</summary>
    public required Guid Id { get; init; }
    /// <summary>The registered name.</summary>
    public required string Name { get; init; }
    /// <summary>What the counterparty is to Acme.</summary>
    public required CounterpartyType Type { get; init; }
    /// <summary>Whether the counterparty can be paid. Archived counterparties are kept for history.</summary>
    public required CounterpartyStatus Status { get; init; }
    /// <summary>The ISO 3166-1 alpha-2 country.</summary>
    public required string Country { get; init; }
    /// <summary>The registered postal address.</summary>
    public required Address Address { get; init; }
    /// <summary>Where remittance advice is sent.</summary>
    public string? ContactEmail { get; init; }
    /// <summary>The beneficiary bank account. The <c>scheme</c> property tells which variant it is.</summary>
    public required BankDetails BankDetails { get; init; }
    /// <summary>The IBAN, or routing and account numbers, as one printable string. Handy in pick lists.</summary>
    public required string AccountIdentifier { get; init; }
    /// <summary>When the counterparty was added.</summary>
    public required DateTimeOffset CreatedAt { get; init; }
}

/// <summary>Fields used to add a counterparty.</summary>
public sealed class CreateCounterpartyRequest
{
    /// <summary>The registered name, unique across active counterparties.</summary>
    [Required, StringLength(120, MinimumLength = 2)] public string Name { get; set; } = "";
    /// <summary>What the counterparty is to Acme.</summary>
    [Required] public CounterpartyType Type { get; set; } = CounterpartyType.Supplier;
    /// <summary>The ISO 3166-1 alpha-2 country.</summary>
    [Required, RegularExpression("^[A-Z]{2}$")] public string Country { get; set; } = "";
    /// <summary>The registered postal address.</summary>
    [Required] public Address Address { get; set; } = new();
    /// <summary>Where remittance advice is sent.</summary>
    [EmailAddress, MaxLength(120)] public string? ContactEmail { get; set; }
    /// <summary>The beneficiary bank account. Set <c>scheme</c> to <c>Iban</c>, <c>UsAch</c> or <c>Swift</c>.</summary>
    [Required] public BankDetails BankDetails { get; set; } = new IbanBankDetails();
}

/// <summary>The mutable fields of a counterparty.</summary>
public sealed class UpdateCounterpartyRequest
{
    /// <summary>The registered name, unique across active counterparties.</summary>
    [Required, StringLength(120, MinimumLength = 2)] public string Name { get; set; } = "";
    /// <summary>The registered postal address.</summary>
    [Required] public Address Address { get; set; } = new();
    /// <summary>Where remittance advice is sent.</summary>
    [EmailAddress, MaxLength(120)] public string? ContactEmail { get; set; }
    /// <summary>The beneficiary bank account. Set <c>scheme</c> to <c>Iban</c>, <c>UsAch</c> or <c>Swift</c>.</summary>
    [Required] public BankDetails BankDetails { get; set; } = new IbanBankDetails();
}
