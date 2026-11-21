using System.ComponentModel;
using System.Text.Json.Serialization;

namespace TreasuryApi;

/// <summary>ISO 4217 currency codes supported by the Acme treasury platform.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<Currency>))]
public enum Currency
{
    /// <summary>Euro.</summary>
    [Description("Euro")] EUR,
    /// <summary>US dollar.</summary>
    [Description("US dollar")] USD,
    /// <summary>Pound sterling.</summary>
    [Description("Pound sterling")] GBP,
    /// <summary>Swiss franc.</summary>
    [Description("Swiss franc")] CHF,
    /// <summary>Swedish krona.</summary>
    [Description("Swedish krona")] SEK,
    /// <summary>Japanese yen, which has no minor unit.</summary>
    [Description("Japanese yen")] JPY,
    /// <summary>Norwegian krone.</summary>
    [Description("Norwegian krone")] NOK,
    /// <summary>Danish krone.</summary>
    [Description("Danish krone")] DKK,
    /// <summary>Canadian dollar.</summary>
    [Description("Canadian dollar")] CAD,
    /// <summary>Australian dollar.</summary>
    [Description("Australian dollar")] AUD,
    /// <summary>Polish złoty.</summary>
    [Description("Polish złoty")] PLN
}

/// <summary>The purpose a bank account serves for its legal entity.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<AccountType>))]
public enum AccountType
{
    /// <summary>Day-to-day payments.</summary>
    [Description("Day-to-day payments and receipts.")] Operating,
    /// <summary>Pays salaries.</summary>
    [Description("Salaries and payroll taxes.")] Payroll,
    /// <summary>Receives customer payments.</summary>
    [Description("Receives customer payments.")] Collections,
    /// <summary>Holds surplus cash and earns interest.</summary>
    [Description("Holds surplus cash and earns interest.")] Savings,
    /// <summary>Holds money on behalf of a third party until a condition is met.</summary>
    [Description("Holds funds on behalf of a third party.")] Escrow
}

/// <summary>Lifecycle of a bank account.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<AccountStatus>))]
public enum AccountStatus
{
    /// <summary>The account can be used.</summary>
    [Description("Sends and receives payments.")] Open,
    /// <summary>The account is blocked; it cannot be debited.</summary>
    [Description("Receives payments but can’t send them.")] Frozen,
    /// <summary>The account was closed and keeps only its history.</summary>
    [Description("No longer used. Kept for history.")] Closed
}

/// <summary>What a counterparty is to Acme.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<CounterpartyType>))]
public enum CounterpartyType
{
    /// <summary>Acme buys from it.</summary>
    Supplier,
    /// <summary>It buys from Acme.</summary>
    Customer,
    /// <summary>Another company of the Acme group.</summary>
    Intercompany,
    /// <summary>A government body that collects taxes.</summary>
    TaxAuthority
}

/// <summary>Whether a counterparty can be paid.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<CounterpartyStatus>))]
public enum CounterpartyStatus
{
    /// <summary>It can be paid.</summary>
    Active,
    /// <summary>It was retired; it keeps its history but cannot be paid.</summary>
    Archived
}

/// <summary>Lifecycle of a payment, from first draft to bank settlement.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<PaymentStatus>))]
public enum PaymentStatus
{
    /// <summary>Created and editable; funds are reserved.</summary>
    [Description("Created, not yet submitted.")] Draft,
    /// <summary>Submitted and waiting for a second person to approve it.</summary>
    [Description("Waiting for an approver.")] PendingApproval,
    /// <summary>Approved and waiting to be scheduled.</summary>
    [Description("Approved, waiting for its value date.")] Approved,
    /// <summary>A reviewer rejected it; the creator can revise and resubmit.</summary>
    [Description("Rejected by an approver.")] Rejected,
    /// <summary>Queued for release to the bank on its value date.</summary>
    [Description("Queued for the bank on its value date.")] Scheduled,
    /// <summary>Sent to the bank.</summary>
    [Description("Sent to the bank.")] Sent,
    /// <summary>The bank confirmed it was executed.</summary>
    [Description("The bank confirmed settlement.")] Settled,
    /// <summary>The bank could not execute it.</summary>
    [Description("The bank rejected it.")] Failed,
    /// <summary>Cancelled before the bank received it; funds were released.</summary>
    [Description("Cancelled before it was sent.")] Cancelled
}

/// <summary>How quickly the bank should execute a payment.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<Priority>))]
public enum Priority
{
    /// <summary>Standard processing on the value date.</summary>
    [Description("Executed in the next standard batch.")] Normal,
    /// <summary>Faster processing, with a bank surcharge.</summary>
    [Description("Executed ahead of the standard batch.")] Urgent,
    /// <summary>Settles the same business day, if submitted before the bank cut-off.</summary>
    [Description("Settles today if sent before the bank’s cut-off.")] [JsonStringEnumMemberName("Same day")] SameDay
}

/// <summary>Which party pays the bank charges on a cross-border payment (ISO 20022 ChargeBearerType1Code).</summary>
[JsonConverter(typeof(JsonStringEnumConverter<ChargeBearer>))]
public enum ChargeBearer
{
    /// <summary>Shared: the sender pays its bank, the beneficiary pays theirs.</summary>
    SHA,
    /// <summary>Our: the sender pays all charges.</summary>
    OUR,
    /// <summary>Beneficiary: the beneficiary pays all charges.</summary>
    BEN
}

/// <summary>A subset of the ISO 20022 external purpose codes (ExternalPurpose1Code).</summary>
[JsonConverter(typeof(JsonStringEnumConverter<PurposeCode>))]
public enum PurposeCode
{
    /// <summary>Supplier payment.</summary>
    SUPP,
    /// <summary>Salary payment.</summary>
    SALA,
    /// <summary>Tax payment.</summary>
    TAXS,
    /// <summary>Intra-company payment.</summary>
    INTC,
    /// <summary>Commercial trade.</summary>
    TRAD,
    /// <summary>Dividend.</summary>
    DIVD,
    /// <summary>Loan.</summary>
    LOAN,
    /// <summary>Rent.</summary>
    RENT,
    /// <summary>Utility bill.</summary>
    UTIL,
    /// <summary>Insurance premium.</summary>
    INSU,
    /// <summary>Government payment.</summary>
    GOVT,
    /// <summary>Pension payment.</summary>
    PENS,
    /// <summary>Cash management transfer.</summary>
    CASH
}

/// <summary>A reviewer's decision on a payment.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<ApprovalDecision>))]
public enum ApprovalDecision
{
    /// <summary>The reviewer approved the payment.</summary>
    Approved,
    /// <summary>The reviewer rejected the payment.</summary>
    Rejected
}

/// <summary>Whether an FX deal settles on the spot date or on an agreed future date.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<FxDealType>))]
public enum FxDealType
{
    /// <summary>Settles two business days after the trade.</summary>
    Spot,
    /// <summary>Settles on an agreed later date at a rate fixed today.</summary>
    Forward
}

/// <summary>Whether Acme buys or sells the base currency of a pair.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<FxSide>))]
public enum FxSide
{
    /// <summary>Acme buys the base currency and pays the quote currency.</summary>
    Buy,
    /// <summary>Acme sells the base currency and receives the quote currency.</summary>
    Sell
}

/// <summary>The currency pairs that can be quoted, written base currency first.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<FxPair>))]
public enum FxPair
{
    /// <summary>Euro against US dollar.</summary>
    EURUSD,
    /// <summary>Euro against pound sterling.</summary>
    EURGBP,
    /// <summary>Pound sterling against US dollar.</summary>
    GBPUSD,
    /// <summary>US dollar against Japanese yen.</summary>
    USDJPY,
    /// <summary>Euro against Japanese yen.</summary>
    EURJPY,
    /// <summary>Euro against Swiss franc.</summary>
    EURCHF,
    /// <summary>US dollar against Swiss franc.</summary>
    USDCHF,
    /// <summary>Euro against Swedish krona.</summary>
    EURSEK,
    /// <summary>US dollar against Swedish krona.</summary>
    USDSEK
}

/// <summary>Lifecycle of an FX deal.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<FxDealStatus>))]
public enum FxDealStatus
{
    /// <summary>Struck with the bank and waiting to settle.</summary>
    Booked,
    /// <summary>The currencies were exchanged.</summary>
    Settled,
    /// <summary>Cancelled before settlement.</summary>
    Cancelled
}

/// <summary>The kind of movement a bank statement entry reports.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<StatementEntryType>))]
public enum StatementEntryType
{
    /// <summary>Money received.</summary>
    Credit,
    /// <summary>Money paid out.</summary>
    Debit,
    /// <summary>A bank charge.</summary>
    Fee,
    /// <summary>Interest paid by the bank.</summary>
    Interest
}

/// <summary>Which scheme identifies a counterparty's bank account.</summary>
public enum BankScheme
{
    /// <summary>An IBAN, with an optional BIC.</summary>
    Iban,
    /// <summary>A US routing number and account number.</summary>
    UsAch,
    /// <summary>A BIC and a local account number.</summary>
    Swift
}

/// <summary>Sort orders for lists, as the <c>sort</c> query values. A leading <c>-</c> reverses the order.</summary>
public static class SortKeys
{
    /// <summary>Payment list sort values.</summary>
    public static readonly string[] Payments = ["valueDate", "-valueDate", "amount", "-amount", "createdAt", "-createdAt", "number", "-number"];
    /// <summary>Account list sort values.</summary>
    public static readonly string[] Accounts = ["name", "-name", "balance", "-balance", "openedOn", "-openedOn"];
    /// <summary>What each account sort value means, shown beside the value in the workbench.</summary>
    public static readonly IReadOnlyDictionary<string, string> AccountDescriptions = new Dictionary<string, string>
    {
        ["name"] = "Name, A to Z", ["-name"] = "Name, Z to A",
        ["balance"] = "Available balance, lowest first", ["-balance"] = "Available balance, highest first",
        ["openedOn"] = "Opened, oldest first", ["-openedOn"] = "Opened, newest first"
    };
    /// <summary>Counterparty list sort values.</summary>
    public static readonly string[] Counterparties = ["name", "-name", "createdAt", "-createdAt"];
    /// <summary>FX deal list sort values.</summary>
    public static readonly string[] FxDeals = ["valueDate", "-valueDate", "baseAmount", "-baseAmount", "tradeDate", "-tradeDate"];
    /// <summary>Bank statement list sort values.</summary>
    public static readonly string[] Statements = ["statementDate", "-statementDate"];
    /// <summary>Approval queue sort values.</summary>
    public static readonly string[] Approvals = ["valueDate", "-valueDate", "amount", "-amount", "submittedAt", "-submittedAt"];
    /// <summary>User list sort values.</summary>
    public static readonly string[] Users = ["name", "-name", "email", "-email"];
}
